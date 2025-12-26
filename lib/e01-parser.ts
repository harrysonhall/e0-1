/**
 * E01 (Expert Witness Format / EnCase) Parser
 *
 * EWF file structure:
 * - Signature (EVF\x09\x0d\x0a\xff\x00)
 * - Sections: header, volume, sectors/data, table, hash, done
 * - Each section has: type (16 bytes), next offset (8 bytes), size (8 bytes), checksum (4 bytes)
 */

// EWF signature bytes
const EWF_SIGNATURE = new Uint8Array([0x45, 0x56, 0x46, 0x09, 0x0d, 0x0a, 0xff, 0x00]);

// Section types
export const SECTION_TYPES = {
  HEADER: 'header',
  HEADER2: 'header2',
  VOLUME: 'volume',
  DISK: 'disk',
  SECTORS: 'sectors',
  TABLE: 'table',
  TABLE2: 'table2',
  DATA: 'data',
  HASH: 'hash',
  DIGEST: 'digest',
  DONE: 'done',
  NEXT: 'next',
} as const;

export interface E01Section {
  type: string;
  nextOffset: bigint;
  size: bigint;
  data: Uint8Array;
  offset: number;
}

export interface E01Metadata {
  caseNumber?: string;
  description?: string;
  examinerName?: string;
  evidenceNumber?: string;
  notes?: string;
  acquiredDate?: string;
  systemDate?: string;
  operatingSystem?: string;
  password?: string;
  compressionLevel?: string;
  [key: string]: string | undefined;
}

export interface E01VolumeInfo {
  mediaType?: number;
  chunkCount?: number;
  sectorsPerChunk?: number;
  bytesPerSector?: number;
  sectorCount?: bigint;
  reserved?: Uint8Array;
}

export interface E01ParseResult {
  valid: boolean;
  signature: Uint8Array;
  sections: E01Section[];
  metadata: E01Metadata;
  volumeInfo: E01VolumeInfo | null;
  rawDiskData: Uint8Array | null;
  hash?: { md5?: string; sha1?: string };
  errors: string[];
}

/**
 * Check if the file has a valid EWF signature
 */
export function checkSignature(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < EWF_SIGNATURE.length; i++) {
    if (data[i] !== EWF_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Read a null-terminated string from a buffer
 */
function readString(data: Uint8Array, offset: number, maxLength: number): string {
  let end = offset;
  while (end < offset + maxLength && end < data.length && data[end] !== 0) {
    end++;
  }
  return new TextDecoder('utf-8').decode(data.slice(offset, end));
}

/**
 * Read a 16-byte section type string
 */
function readSectionType(data: Uint8Array, offset: number): string {
  return readString(data, offset, 16).toLowerCase().trim();
}

/**
 * Read a 64-bit little-endian unsigned integer
 */
function readUint64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const low = view.getUint32(0, true);
  const high = view.getUint32(4, true);
  return BigInt(low) + (BigInt(high) << 32n);
}

/**
 * Read a 32-bit little-endian unsigned integer
 */
function readUint32LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, true);
}

/**
 * Parse the header section to extract metadata
 * Header is typically zlib compressed and contains key-value pairs
 */
function parseHeaderSection(sectionData: Uint8Array): E01Metadata {
  const metadata: E01Metadata = {};

  try {
    // Try to decompress with pako if available, otherwise try raw
    let decompressed: Uint8Array | null = null;

    // Check if data looks compressed (zlib header: 0x78)
    if (sectionData.length > 2 && sectionData[0] === 0x78) {
      // Try browser's DecompressionStream if available
      try {
        decompressed = decompressZlib(sectionData);
      } catch {
        // Fall through to try raw
      }
    }

    const textData = decompressed || sectionData;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(textData);

    // Parse the header format: lines of key=value or key\tvalue
    // Common format: category\nkey\tvalue\nkey\tvalue\n\n
    const lines = text.split(/[\r\n]+/);

    for (const line of lines) {
      // Try tab-separated first
      let parts = line.split('\t');
      if (parts.length < 2) {
        // Try equals sign
        parts = line.split('=');
      }

      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join('=').trim();

        // Map common keys
        switch (key) {
          case 'c': case 'case': case 'case_number':
            metadata.caseNumber = value;
            break;
          case 'n': case 'name': case 'description':
            metadata.description = value;
            break;
          case 'e': case 'examiner': case 'examiner_name':
            metadata.examinerName = value;
            break;
          case 'ev': case 'evidence': case 'evidence_number':
            metadata.evidenceNumber = value;
            break;
          case 'no': case 'notes':
            metadata.notes = value;
            break;
          case 'a': case 'acquired': case 'acquired_date':
            metadata.acquiredDate = value;
            break;
          case 'm': case 'system': case 'system_date':
            metadata.systemDate = value;
            break;
          case 'os': case 'operating_system':
            metadata.operatingSystem = value;
            break;
          case 'p': case 'password':
            metadata.password = value;
            break;
          case 'r': case 'compression':
            metadata.compressionLevel = value;
            break;
          default:
            if (key && value) {
              metadata[key] = value;
            }
        }
      }
    }
  } catch (error) {
    console.error('Error parsing header section:', error);
  }

  return metadata;
}

/**
 * Basic zlib decompression using browser APIs or manual inflate
 */
function decompressZlib(data: Uint8Array): Uint8Array {
  // Skip zlib header (2 bytes) and checksum (4 bytes at end)
  // Use raw deflate data
  const deflateData = data.slice(2, -4);

  // Simple inflate implementation for basic cases
  // For production, you'd want pako or similar
  return inflateRaw(deflateData);
}

/**
 * Basic raw inflate implementation
 * Note: This is simplified - for production use pako library
 */
function inflateRaw(data: Uint8Array): Uint8Array {
  // For now, return the data as-is if we can't decompress
  // In a real implementation, we'd use pako or implement full DEFLATE

  // Try to detect if it's already uncompressed text
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (text.includes('=') || text.includes('\t')) {
    return data;
  }

  // Return original data
  return data;
}

/**
 * Parse volume section to get disk geometry
 */
function parseVolumeSection(sectionData: Uint8Array): E01VolumeInfo {
  const info: E01VolumeInfo = {};

  if (sectionData.length >= 32) {
    // EWF volume section format
    info.mediaType = sectionData[0];
    info.chunkCount = readUint32LE(sectionData, 4);
    info.sectorsPerChunk = readUint32LE(sectionData, 8);
    info.bytesPerSector = readUint32LE(sectionData, 12);
    info.sectorCount = readUint64LE(sectionData, 16);
  }

  return info;
}

/**
 * Parse hash section
 */
function parseHashSection(sectionData: Uint8Array): { md5?: string; sha1?: string } {
  const result: { md5?: string; sha1?: string } = {};

  // MD5 is typically at the start (16 bytes)
  if (sectionData.length >= 16) {
    result.md5 = Array.from(sectionData.slice(0, 16))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // SHA1 might follow (20 bytes)
  if (sectionData.length >= 36) {
    result.sha1 = Array.from(sectionData.slice(16, 36))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return result;
}

/**
 * Main parser function
 */
export async function parseE01(file: File): Promise<E01ParseResult> {
  const result: E01ParseResult = {
    valid: false,
    signature: new Uint8Array(8),
    sections: [],
    metadata: {},
    volumeInfo: null,
    rawDiskData: null,
    errors: [],
  };

  try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    // Check signature
    if (!checkSignature(data)) {
      result.errors.push('Invalid EWF signature. This may not be a valid E01 file.');
      return result;
    }

    result.signature = data.slice(0, 8);
    result.valid = true;

    // Parse sections
    let offset = 13; // After signature + segment number (5 bytes)
    const dataChunks: Uint8Array[] = [];

    while (offset < data.length - 76) { // Minimum section header size
      // Read section header
      const sectionType = readSectionType(data, offset);
      const nextOffset = readUint64LE(data, offset + 16);
      const sectionSize = readUint64LE(data, offset + 24);

      // Skip empty or invalid sections
      if (!sectionType || sectionSize === 0n) {
        break;
      }

      // Calculate data offset (after 76-byte section descriptor)
      const dataOffset = offset + 76;
      const dataSize = Number(sectionSize);

      // Ensure we don't read past end of file
      const safeDataSize = Math.min(dataSize, data.length - dataOffset);
      const sectionData = data.slice(dataOffset, dataOffset + safeDataSize);

      const section: E01Section = {
        type: sectionType,
        nextOffset,
        size: sectionSize,
        data: sectionData,
        offset,
      };

      result.sections.push(section);

      // Parse specific section types
      if (sectionType === SECTION_TYPES.HEADER || sectionType === SECTION_TYPES.HEADER2) {
        const headerMeta = parseHeaderSection(sectionData);
        result.metadata = { ...result.metadata, ...headerMeta };
      } else if (sectionType === SECTION_TYPES.VOLUME || sectionType === SECTION_TYPES.DISK) {
        result.volumeInfo = parseVolumeSection(sectionData);
      } else if (sectionType === SECTION_TYPES.SECTORS || sectionType === SECTION_TYPES.DATA) {
        // Collect disk data chunks
        dataChunks.push(sectionData);
      } else if (sectionType === SECTION_TYPES.HASH || sectionType === SECTION_TYPES.DIGEST) {
        result.hash = parseHashSection(sectionData);
      } else if (sectionType === SECTION_TYPES.DONE) {
        break;
      }

      // Move to next section
      if (nextOffset > BigInt(offset)) {
        offset = Number(nextOffset);
      } else {
        offset = dataOffset + safeDataSize;
      }

      // Safety check to prevent infinite loops
      if (offset <= section.offset) {
        break;
      }
    }

    // Combine data chunks into raw disk data
    if (dataChunks.length > 0) {
      const totalSize = dataChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      result.rawDiskData = new Uint8Array(totalSize);
      let pos = 0;
      for (const chunk of dataChunks) {
        result.rawDiskData.set(chunk, pos);
        pos += chunk.length;
      }
    }

  } catch (error) {
    result.errors.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number | bigint): string {
  const num = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = num;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Convert bytes to hex string for display
 */
export function bytesToHex(bytes: Uint8Array, maxLength = 256): string {
  const displayBytes = bytes.slice(0, maxLength);
  return Array.from(displayBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/**
 * Format hex dump with offset, hex, and ASCII columns
 */
export function hexDump(bytes: Uint8Array, offset = 0, length = 256): string[] {
  const lines: string[] = [];
  const end = Math.min(offset + length, bytes.length);

  for (let i = offset; i < end; i += 16) {
    const lineBytes = bytes.slice(i, Math.min(i + 16, end));

    // Offset column
    const offsetStr = i.toString(16).padStart(8, '0');

    // Hex column
    const hexParts: string[] = [];
    for (let j = 0; j < 16; j++) {
      if (j < lineBytes.length) {
        hexParts.push(lineBytes[j].toString(16).padStart(2, '0'));
      } else {
        hexParts.push('  ');
      }
    }
    const hexStr = hexParts.join(' ');

    // ASCII column
    const asciiStr = Array.from(lineBytes)
      .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.')
      .join('');

    lines.push(`${offsetStr}  ${hexStr}  |${asciiStr.padEnd(16, ' ')}|`);
  }

  return lines;
}
