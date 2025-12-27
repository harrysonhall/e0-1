/**
 * Partition Table Parser
 * Supports MBR (Master Boot Record) and GPT (GUID Partition Table)
 */

export interface Partition {
  index: number;
  type: string;
  typeCode: number | string;
  startLBA: number;
  endLBA: number;
  sizeLBA: number;
  sizeBytes: bigint;
  bootable: boolean;
  name?: string;
  guid?: string;
  filesystem?: string;
}

export interface PartitionTable {
  type: 'MBR' | 'GPT' | 'Unknown';
  sectorSize: number;
  partitions: Partition[];
  diskGuid?: string;
}

// MBR Partition Type Codes
const MBR_PARTITION_TYPES: Record<number, string> = {
  0x00: 'Empty',
  0x01: 'FAT12',
  0x04: 'FAT16 (<32MB)',
  0x05: 'Extended',
  0x06: 'FAT16',
  0x07: 'NTFS/exFAT/HPFS',
  0x0b: 'FAT32 (CHS)',
  0x0c: 'FAT32 (LBA)',
  0x0e: 'FAT16 (LBA)',
  0x0f: 'Extended (LBA)',
  0x11: 'Hidden FAT12',
  0x14: 'Hidden FAT16 (<32MB)',
  0x16: 'Hidden FAT16',
  0x17: 'Hidden NTFS',
  0x1b: 'Hidden FAT32',
  0x1c: 'Hidden FAT32 (LBA)',
  0x1e: 'Hidden FAT16 (LBA)',
  0x27: 'Windows Recovery',
  0x42: 'Windows Dynamic',
  0x82: 'Linux Swap',
  0x83: 'Linux',
  0x85: 'Linux Extended',
  0x8e: 'Linux LVM',
  0xee: 'GPT Protective MBR',
  0xef: 'EFI System',
  0xfd: 'Linux RAID',
};

// GPT Partition Type GUIDs
const GPT_PARTITION_TYPES: Record<string, string> = {
  '00000000-0000-0000-0000-000000000000': 'Unused',
  'c12a7328-f81f-11d2-ba4b-00a0c93ec93b': 'EFI System',
  '024dee41-33e7-11d3-9d69-0008c781f39f': 'MBR Partition Scheme',
  'e3c9e316-0b5c-4db8-817d-f92df00215ae': 'Microsoft Reserved',
  'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7': 'Microsoft Basic Data',
  'de94bba4-06d1-4d40-a16a-bfd50179d6ac': 'Windows Recovery',
  '0fc63daf-8483-4772-8e79-3d69d8477de4': 'Linux Filesystem',
  '0657fd6d-a4ab-43c4-84e5-0933c84b4f4f': 'Linux Swap',
  'e6d6d379-f507-44c2-a23c-238f2a3df928': 'Linux LVM',
  '933ac7e1-2eb4-4f13-b844-0e14e2aef915': 'Linux Home',
  '48465300-0000-11aa-aa11-00306543ecac': 'Apple HFS+',
  '7c3457ef-0000-11aa-aa11-00306543ecac': 'Apple APFS',
};

function readUint32LE(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) return 0;
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, true);
}

function readUint64LE(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) return 0n;
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const low = view.getUint32(0, true);
  const high = view.getUint32(4, true);
  return BigInt(low) + (BigInt(high) << 32n);
}

function readGuid(data: Uint8Array, offset: number): string {
  if (offset + 16 > data.length) return '';
  const p1 = readUint32LE(data, offset).toString(16).padStart(8, '0');
  const p2 = ((data[offset + 5] << 8) | data[offset + 4]).toString(16).padStart(4, '0');
  const p3 = ((data[offset + 7] << 8) | data[offset + 6]).toString(16).padStart(4, '0');
  const p4 = Array.from(data.slice(offset + 8, offset + 10))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const p5 = Array.from(data.slice(offset + 10, offset + 16))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

function parseMBRPartitionEntry(data: Uint8Array, offset: number, index: number, sectorSize: number): Partition | null {
  if (offset + 16 > data.length) return null;
  const bootFlag = data[offset];
  const typeCode = data[offset + 4];
  if (typeCode === 0x00) return null;
  const startLBA = readUint32LE(data, offset + 8);
  const sizeLBA = readUint32LE(data, offset + 12);
  return {
    index,
    type: MBR_PARTITION_TYPES[typeCode] || `Unknown (0x${typeCode.toString(16)})`,
    typeCode,
    startLBA,
    endLBA: startLBA + sizeLBA - 1,
    sizeLBA,
    sizeBytes: BigInt(sizeLBA) * BigInt(sectorSize),
    bootable: bootFlag === 0x80,
    filesystem: guessFilesystem(typeCode),
  };
}

function guessFilesystem(typeCode: number): string | undefined {
  switch (typeCode) {
    case 0x01: return 'FAT12';
    case 0x04: case 0x06: case 0x0e: case 0x14: case 0x16: case 0x1e: return 'FAT16';
    case 0x0b: case 0x0c: case 0x1b: case 0x1c: return 'FAT32';
    case 0x07: case 0x17: return 'NTFS';
    case 0x83: return 'Linux (ext2/3/4)';
    case 0xef: return 'FAT32';
    default: return undefined;
  }
}

function parseMBR(data: Uint8Array, sectorSize: number): PartitionTable {
  const result: PartitionTable = { type: 'MBR', sectorSize, partitions: [] };
  if (data.length < 512 || data[510] !== 0x55 || data[511] !== 0xaa) {
    result.type = 'Unknown';
    return result;
  }
  for (let i = 0; i < 4; i++) {
    const partition = parseMBRPartitionEntry(data, 446 + (i * 16), i + 1, sectorSize);
    if (partition) {
      if (partition.typeCode === 0xee) {
        return parseGPT(data, sectorSize);
      }
      result.partitions.push(partition);
    }
  }
  return result;
}

function parseGPT(data: Uint8Array, sectorSize: number): PartitionTable {
  const result: PartitionTable = { type: 'GPT', sectorSize, partitions: [] };
  const gptHeaderOffset = sectorSize;
  if (data.length < gptHeaderOffset + 92) return result;
  const signature = new TextDecoder().decode(data.slice(gptHeaderOffset, gptHeaderOffset + 8));
  if (signature !== 'EFI PART') {
    result.type = 'Unknown';
    return result;
  }
  result.diskGuid = readGuid(data, gptHeaderOffset + 56);
  const partitionEntryLBA = Number(readUint64LE(data, gptHeaderOffset + 72));
  const numPartitionEntries = readUint32LE(data, gptHeaderOffset + 80);
  const partitionEntrySize = readUint32LE(data, gptHeaderOffset + 84);
  const partitionTableOffset = partitionEntryLBA * sectorSize;

  for (let i = 0; i < numPartitionEntries && i < 128; i++) {
    const entryOffset = partitionTableOffset + (i * partitionEntrySize);
    if (entryOffset + partitionEntrySize > data.length) break;
    const typeGuid = readGuid(data, entryOffset);
    if (typeGuid === '00000000-0000-0000-0000-000000000000') continue;
    const partitionGuid = readGuid(data, entryOffset + 16);
    const startLBA = Number(readUint64LE(data, entryOffset + 32));
    const endLBA = Number(readUint64LE(data, entryOffset + 40));
    const nameBytes = data.slice(entryOffset + 56, entryOffset + 128);
    let name = '';
    try { name = new TextDecoder('utf-16le').decode(nameBytes).replace(/\0+$/, ''); } catch {}
    const typeName = GPT_PARTITION_TYPES[typeGuid.toLowerCase()] || `Unknown (${typeGuid})`;
    result.partitions.push({
      index: i + 1,
      type: typeName,
      typeCode: typeGuid,
      startLBA,
      endLBA,
      sizeLBA: endLBA - startLBA + 1,
      sizeBytes: BigInt(endLBA - startLBA + 1) * BigInt(sectorSize),
      bootable: false,
      name: name || undefined,
      guid: partitionGuid,
      filesystem: guessGPTFilesystem(typeGuid),
    });
  }
  return result;
}

function guessGPTFilesystem(typeGuid: string): string | undefined {
  const guid = typeGuid.toLowerCase();
  if (guid === 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b') return 'FAT32';
  if (guid === 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7') return 'NTFS';
  if (guid === '0fc63daf-8483-4772-8e79-3d69d8477de4') return 'ext4';
  if (guid === '48465300-0000-11aa-aa11-00306543ecac') return 'HFS+';
  if (guid === '7c3457ef-0000-11aa-aa11-00306543ecac') return 'APFS';
  return undefined;
}

export function parsePartitionTable(data: Uint8Array, sectorSize = 512): PartitionTable {
  if (data.length < 512) return { type: 'Unknown', sectorSize, partitions: [] };
  return parseMBR(data, sectorSize);
}

export function extractPartitionData(diskData: Uint8Array, partition: Partition, sectorSize = 512): Uint8Array {
  const startOffset = partition.startLBA * sectorSize;
  const endOffset = (partition.endLBA + 1) * sectorSize;
  if (startOffset >= diskData.length) return new Uint8Array(0);
  return diskData.slice(startOffset, Math.min(endOffset, diskData.length));
}
