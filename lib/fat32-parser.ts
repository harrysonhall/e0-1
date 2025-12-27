/**
 * FAT32 Filesystem Parser
 */

export interface FATBootSector {
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectors: number;
  numFATs: number;
  rootEntryCount: number;
  totalSectors: number;
  sectorsPerFAT: number;
  rootCluster: number;
  volumeLabel: string;
  fsType: string;
}

export interface FATFileEntry {
  name: string;
  shortName: string;
  extension: string;
  fullName: string;
  isDirectory: boolean;
  isHidden: boolean;
  isSystem: boolean;
  size: number;
  cluster: number;
  children?: FATFileEntry[];
  path: string;
}

export interface FATParseResult {
  valid: boolean;
  fatType: 'FAT12' | 'FAT16' | 'FAT32' | 'Unknown';
  bootSector: FATBootSector | null;
  rootEntries: FATFileEntry[];
  errors: string[];
}

function readUint16LE(data: Uint8Array, offset: number): number {
  if (offset + 2 > data.length) return 0;
  return data[offset] | (data[offset + 1] << 8);
}

function readUint32LE(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) return 0;
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, true);
}

function parseBootSector(data: Uint8Array): FATBootSector | null {
  if (data.length < 512) return null;
  if (data[510] !== 0x55 || data[511] !== 0xaa) return null;

  const bytesPerSector = readUint16LE(data, 11);
  const sectorsPerCluster = data[13];
  const reservedSectors = readUint16LE(data, 14);
  const numFATs = data[16];
  const rootEntryCount = readUint16LE(data, 17);
  let totalSectors = readUint16LE(data, 19);
  let sectorsPerFAT = readUint16LE(data, 22);

  if (totalSectors === 0) totalSectors = readUint32LE(data, 32);

  let rootCluster = 0;
  let volumeLabel = '';
  let fsType = '';

  if (sectorsPerFAT === 0) {
    sectorsPerFAT = readUint32LE(data, 36);
    rootCluster = readUint32LE(data, 44);
    volumeLabel = new TextDecoder('ascii').decode(data.slice(71, 82)).trim();
    fsType = new TextDecoder('ascii').decode(data.slice(82, 90)).trim();
  } else {
    volumeLabel = new TextDecoder('ascii').decode(data.slice(43, 54)).trim();
    fsType = new TextDecoder('ascii').decode(data.slice(54, 62)).trim();
  }

  return { bytesPerSector, sectorsPerCluster, reservedSectors, numFATs, rootEntryCount, totalSectors, sectorsPerFAT, rootCluster, volumeLabel, fsType };
}

function determineFATType(bs: FATBootSector): 'FAT12' | 'FAT16' | 'FAT32' {
  const rootDirSectors = Math.ceil((bs.rootEntryCount * 32) / bs.bytesPerSector);
  const dataSectors = bs.totalSectors - bs.reservedSectors - bs.numFATs * bs.sectorsPerFAT - rootDirSectors;
  const clusterCount = Math.floor(dataSectors / bs.sectorsPerCluster);
  if (clusterCount < 4085) return 'FAT12';
  if (clusterCount < 65525) return 'FAT16';
  return 'FAT32';
}

function parseDirectoryEntry(data: Uint8Array, offset: number, longNameBuffer: string[], parentPath: string): { entry: FATFileEntry | null; isEnd: boolean } {
  if (offset + 32 > data.length) return { entry: null, isEnd: true };
  const firstByte = data[offset];
  if (firstByte === 0x00) return { entry: null, isEnd: true };
  if (firstByte === 0xe5) return { entry: null, isEnd: false };

  const attr = data[offset + 11];
  if ((attr & 0x0f) === 0x0f) {
    const ordinal = firstByte & 0x3f;
    const chars: number[] = [];
    for (const o of [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]) {
      const char = readUint16LE(data, offset + o);
      if (char === 0x0000 || char === 0xffff) break;
      chars.push(char);
    }
    longNameBuffer[ordinal - 1] = String.fromCharCode(...chars);
    return { entry: null, isEnd: false };
  }

  const shortNameBytes = data.slice(offset, offset + 8);
  const extBytes = data.slice(offset + 8, offset + 11);
  let shortName = new TextDecoder('ascii').decode(shortNameBytes).trim();
  const extension = new TextDecoder('ascii').decode(extBytes).trim();
  if (shortNameBytes[0] === 0x05) shortName = '\u00e5' + shortName.slice(1);

  const isDirectory = (attr & 0x10) !== 0;
  const isHidden = (attr & 0x02) !== 0;
  const isSystem = (attr & 0x04) !== 0;
  const isVolumeLabel = (attr & 0x08) !== 0;

  if (isVolumeLabel && !isDirectory) return { entry: null, isEnd: false };

  const clusterLow = readUint16LE(data, offset + 26);
  const clusterHigh = readUint16LE(data, offset + 20);
  const cluster = (clusterHigh << 16) | clusterLow;
  const size = readUint32LE(data, offset + 28);

  const isDotEntry = shortName === '.' || shortName === '..';
  let fullName: string;
  if (longNameBuffer.length > 0 && !isDotEntry) {
    fullName = longNameBuffer.join('');
    longNameBuffer.length = 0;
  } else if (extension && !isDotEntry) {
    fullName = `${shortName}.${extension}`;
  } else {
    fullName = shortName;
  }

  if (isDotEntry) return { entry: null, isEnd: false };

  const path = parentPath ? `${parentPath}/${fullName}` : fullName;
  return { entry: { name: fullName, shortName, extension, fullName, isDirectory, isHidden, isSystem, size, cluster, path }, isEnd: false };
}

function getNextCluster(fat: Uint8Array, cluster: number, fatType: 'FAT12' | 'FAT16' | 'FAT32'): number {
  if (fatType === 'FAT32') {
    const offset = cluster * 4;
    if (offset + 4 > fat.length) return 0x0fffffff;
    return readUint32LE(fat, offset) & 0x0fffffff;
  } else if (fatType === 'FAT16') {
    const offset = cluster * 2;
    if (offset + 2 > fat.length) return 0xffff;
    return readUint16LE(fat, offset);
  } else {
    const offset = cluster + Math.floor(cluster / 2);
    if (offset + 2 > fat.length) return 0xfff;
    const value = readUint16LE(fat, offset);
    return cluster % 2 === 0 ? value & 0x0fff : value >> 4;
  }
}

function isEndOfChain(cluster: number, fatType: 'FAT12' | 'FAT16' | 'FAT32'): boolean {
  if (fatType === 'FAT32') return cluster >= 0x0ffffff8;
  if (fatType === 'FAT16') return cluster >= 0xfff8;
  return cluster >= 0xff8;
}

function readClusterChain(data: Uint8Array, fat: Uint8Array, startCluster: number, bs: FATBootSector, fatType: 'FAT12' | 'FAT16' | 'FAT32'): Uint8Array {
  const clusterSize = bs.sectorsPerCluster * bs.bytesPerSector;
  const rootDirSectors = Math.ceil((bs.rootEntryCount * 32) / bs.bytesPerSector);
  const firstDataSector = bs.reservedSectors + bs.numFATs * bs.sectorsPerFAT + rootDirSectors;
  const clusters: Uint8Array[] = [];
  let cluster = startCluster;
  let iterations = 0;

  while (cluster >= 2 && !isEndOfChain(cluster, fatType) && iterations < 10000) {
    const clusterOffset = firstDataSector * bs.bytesPerSector + (cluster - 2) * clusterSize;
    if (clusterOffset + clusterSize <= data.length) {
      clusters.push(data.slice(clusterOffset, clusterOffset + clusterSize));
    }
    cluster = getNextCluster(fat, cluster, fatType);
    iterations++;
  }

  const totalSize = clusters.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const c of clusters) { result.set(c, offset); offset += c.length; }
  return result;
}

function parseDirectory(dirData: Uint8Array, parentPath: string): FATFileEntry[] {
  const entries: FATFileEntry[] = [];
  const longNameBuffer: string[] = [];
  for (let offset = 0; offset < dirData.length; offset += 32) {
    const { entry, isEnd } = parseDirectoryEntry(dirData, offset, longNameBuffer, parentPath);
    if (isEnd) break;
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseDirectoryTree(data: Uint8Array, fat: Uint8Array, cluster: number, bs: FATBootSector, fatType: 'FAT12' | 'FAT16' | 'FAT32', parentPath: string, depth: number): FATFileEntry[] {
  if (depth > 10) return [];
  const dirData = readClusterChain(data, fat, cluster, bs, fatType);
  const entries = parseDirectory(dirData, parentPath);
  for (const entry of entries) {
    if (entry.isDirectory && entry.cluster >= 2) {
      entry.children = parseDirectoryTree(data, fat, entry.cluster, bs, fatType, entry.path, depth + 1);
    }
  }
  return entries;
}

export function parseFAT(data: Uint8Array): FATParseResult {
  const result: FATParseResult = { valid: false, fatType: 'Unknown', bootSector: null, rootEntries: [], errors: [] };

  try {
    const bootSector = parseBootSector(data);
    if (!bootSector) { result.errors.push('Invalid FAT boot sector'); return result; }

    result.bootSector = bootSector;
    result.fatType = determineFATType(bootSector);
    result.valid = true;

    const fatOffset = bootSector.reservedSectors * bootSector.bytesPerSector;
    const fatSize = bootSector.sectorsPerFAT * bootSector.bytesPerSector;
    if (fatOffset + fatSize > data.length) { result.errors.push('FAT extends beyond disk image'); return result; }

    const fat = data.slice(fatOffset, fatOffset + fatSize);

    if (result.fatType === 'FAT32') {
      result.rootEntries = parseDirectoryTree(data, fat, bootSector.rootCluster, bootSector, result.fatType, '', 0);
    } else {
      const rootDirOffset = (bootSector.reservedSectors + bootSector.numFATs * bootSector.sectorsPerFAT) * bootSector.bytesPerSector;
      const rootDirSize = bootSector.rootEntryCount * 32;
      if (rootDirOffset + rootDirSize > data.length) { result.errors.push('Root directory extends beyond disk image'); return result; }
      const rootDirData = data.slice(rootDirOffset, rootDirOffset + rootDirSize);
      const rootEntries = parseDirectory(rootDirData, '');
      for (const entry of rootEntries) {
        if (entry.isDirectory && entry.cluster >= 2) {
          entry.children = parseDirectoryTree(data, fat, entry.cluster, bootSector, result.fatType, entry.path, 0);
        }
      }
      result.rootEntries = rootEntries;
    }
  } catch (error) {
    result.errors.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, exp);
  return `${size.toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`;
}
