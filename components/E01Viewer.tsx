'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  parseE01,
  E01ParseResult,
  E01DebugInfo,
  hexDump,
  formatBytes,
} from '@/lib/e01-parser';
import {
  parsePartitionTable,
  extractPartitionData,
  PartitionTable,
  Partition,
} from '@/lib/partition-parser';
import { parseFAT, FATParseResult, FATFileEntry, formatFileSize } from '@/lib/fat32-parser';

type TabType = 'metadata' | 'sections' | 'files' | 'hex';

// Global log storage - persists across renders
const globalLogs: string[] = [];
const addLog = (type: string, ...args: unknown[]) => {
  const timestamp = new Date().toISOString();
  const message = args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  globalLogs.push(`[${timestamp}] [${type}] ${message}`);
  // Keep only last 500 logs
  if (globalLogs.length > 500) globalLogs.shift();
};

interface FileTreeItemProps {
  entry: FATFileEntry;
  depth: number;
}

function FileTreeItem({ entry, depth }: FileTreeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = entry.children && entry.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 px-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded cursor-pointer text-sm"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {entry.isDirectory ? (
          <span className="w-4 text-center text-gray-400">
            {hasChildren ? (expanded ? '▼' : '▶') : ''}
          </span>
        ) : (
          <span className="w-4" />
        )}
        <span className="text-lg">{entry.isDirectory ? '📁' : '📄'}</span>
        <span className={`flex-1 truncate ${entry.isHidden ? 'text-gray-400' : ''}`}>
          {entry.name}
        </span>
        {!entry.isDirectory && entry.size > 0 && (
          <span className="text-gray-500 text-xs">{formatFileSize(entry.size)}</span>
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {entry.children?.map((child, i) => (
            <FileTreeItem key={i} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function E01Viewer() {
  const [result, setResult] = useState<E01ParseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [parsingFiles, setParsingFiles] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [hexOffset, setHexOffset] = useState(0);
  const [activeTab, setActiveTab] = useState<TabType>('metadata');
  const [copied, setCopied] = useState(false);
  const [lastAction, setLastAction] = useState<string>('Component mounted');

  const [partitionTable, setPartitionTable] = useState<PartitionTable | null>(null);
  const [selectedPartition, setSelectedPartition] = useState<number | null>(null);
  const [fatResult, setFatResult] = useState<FATParseResult | null>(null);
  const [fsErrors, setFsErrors] = useState<string[]>([]);

  // Intercept console methods to capture logs
  const originalConsole = useRef<{
    log: typeof console.log;
    error: typeof console.error;
    warn: typeof console.warn;
  } | null>(null);

  useEffect(() => {
    addLog('INFO', 'E01Viewer component mounted');

    // Store original console methods
    if (!originalConsole.current) {
      originalConsole.current = {
        log: console.log.bind(console),
        error: console.error.bind(console),
        warn: console.warn.bind(console),
      };

      // Override console methods
      console.log = (...args: unknown[]) => {
        addLog('LOG', ...args);
        originalConsole.current?.log(...args);
      };
      console.error = (...args: unknown[]) => {
        addLog('ERROR', ...args);
        originalConsole.current?.error(...args);
      };
      console.warn = (...args: unknown[]) => {
        addLog('WARN', ...args);
        originalConsole.current?.warn(...args);
      };
    }

    // Capture unhandled errors
    const errorHandler = (event: ErrorEvent) => {
      addLog('UNCAUGHT_ERROR', event.message, event.filename, event.lineno, event.error);
    };
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      addLog('UNHANDLED_REJECTION', event.reason);
    };

    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectionHandler);

    return () => {
      window.removeEventListener('error', errorHandler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
    };
  }, []);

  const processFile = useCallback(async (file: File) => {
    addLog('INFO', 'processFile called', file.name, file.size);
    setLastAction(`Processing file: ${file.name}`);
    setLoading(true);
    setFileName(file.name);
    setFileSize(file.size);
    setHexOffset(0);
    setPartitionTable(null);
    setSelectedPartition(null);
    setFatResult(null);
    setFsErrors([]);

    const errorDebug: E01DebugInfo = {
      fileSize: file.size,
      parseStartTime: Date.now(),
      sectionsFound: [],
      chunksProcessed: 0,
      lastOffset: 0,
      logs: [`File: ${file.name}`, `Size: ${file.size} bytes`],
    };

    try {
      addLog('INFO', 'Calling parseE01...');
      const parseResult = await parseE01(file);
      addLog('INFO', 'parseE01 returned', { valid: parseResult.valid, errors: parseResult.errors.length });

      setResult(parseResult);
      setLastAction(`Parsed: ${file.name} - ${parseResult.valid ? 'Valid' : 'Invalid'}`);

      if (parseResult.rawDiskData && parseResult.rawDiskData.length > 0) {
        addLog('INFO', 'Parsing partition table...');
        const partTable = parsePartitionTable(parseResult.rawDiskData);
        setPartitionTable(partTable);
        addLog('INFO', 'Partition table parsed', { type: partTable.type, count: partTable.partitions.length });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      addLog('ERROR', 'Critical error in processFile', errorMsg, errorStack);
      setLastAction(`Error: ${errorMsg}`);

      errorDebug.logs.push(`CRITICAL ERROR: ${errorMsg}`);
      if (errorStack) errorDebug.logs.push(`Stack: ${errorStack}`);
      errorDebug.parseEndTime = Date.now();
      errorDebug.parseDuration = errorDebug.parseEndTime - errorDebug.parseStartTime;

      setResult({
        valid: false,
        signature: new Uint8Array(8),
        sections: [],
        metadata: {},
        volumeInfo: null,
        rawDiskData: null,
        errors: [`Failed to parse file: ${errorMsg}`],
        debug: errorDebug,
      });
    }

    setLoading(false);
    addLog('INFO', 'processFile complete');
  }, []);

  const handleFileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    addLog('INFO', 'handleFileDrop triggered');
    setLastAction('File dropped');
    e.preventDefault();
    e.stopPropagation();

    const file = e.dataTransfer.files[0];
    if (file) {
      addLog('INFO', 'File from drop:', file.name, file.size);
      // Use setTimeout to ensure state updates complete before heavy processing
      setTimeout(() => processFile(file), 0);
    }
  }, [processFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    addLog('INFO', 'handleFileSelect triggered');
    setLastAction('File selected via input');

    const file = e.target.files?.[0];
    if (file) {
      addLog('INFO', 'File from input:', file.name, file.size);
      // Use setTimeout to ensure state updates complete before heavy processing
      setTimeout(() => processFile(file), 0);
    }

    // Reset input so same file can be selected again
    e.target.value = '';
  }, [processFile]);

  const parsePartitionFilesystem = async (partition: Partition) => {
    if (!result?.rawDiskData) return;
    addLog('INFO', 'parsePartitionFilesystem', partition.index);

    setParsingFiles(true);
    setSelectedPartition(partition.index);
    setFatResult(null);
    setFsErrors([]);

    try {
      const partitionData = extractPartitionData(
        result.rawDiskData,
        partition,
        partitionTable?.sectorSize || 512
      );

      if (partitionData.length === 0) {
        setFsErrors(['Could not extract partition data']);
        setParsingFiles(false);
        return;
      }

      const fatParsed = parseFAT(partitionData);
      if (fatParsed.valid) {
        setFatResult(fatParsed);
      } else {
        setFsErrors(['Could not parse filesystem (tried FAT)']);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog('ERROR', 'parsePartitionFilesystem error', msg);
      setFsErrors([`Failed to parse filesystem: ${msg}`]);
    }

    setParsingFiles(false);
  };

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // ALWAYS VISIBLE DEBUG BUTTON - copies all logs and state
  const copyAllDebugInfo = useCallback(async () => {
    addLog('INFO', 'copyAllDebugInfo called');

    const info = {
      timestamp: new Date().toISOString(),
      lastAction,
      fileName,
      fileSize,
      loading,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A',
      url: typeof window !== 'undefined' ? window.location.href : 'N/A',

      // All captured logs
      logs: [...globalLogs],

      // Parser debug info if available
      parserDebug: result?.debug || null,

      // Current state
      state: {
        hasResult: !!result,
        resultValid: result?.valid,
        sectionsCount: result?.sections.length,
        sectionTypes: result?.sections.map(s => s.type),
        hasRawData: !!result?.rawDiskData,
        rawDataSize: result?.rawDiskData?.length,
        errors: result?.errors,
        hasPartitionTable: !!partitionTable,
        partitionCount: partitionTable?.partitions.length,
      },
    };

    const debugText = JSON.stringify(info, null, 2);

    try {
      await navigator.clipboard.writeText(debugText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      addLog('INFO', 'Debug info copied to clipboard');
    } catch (err) {
      addLog('ERROR', 'Failed to copy to clipboard', err);
      // Try alternative method
      const textarea = document.createElement('textarea');
      textarea.value = debugText;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        alert('Could not copy. Check console.');
      }
      document.body.removeChild(textarea);
    }
  }, [lastAction, fileName, fileSize, loading, result, partitionTable]);

  return (
    <>
      {/* FIXED DEBUG BUTTON - ALWAYS VISIBLE */}
      <button
        onClick={copyAllDebugInfo}
        className="fixed bottom-4 right-4 z-50 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg font-medium text-sm transition-colors"
        style={{ zIndex: 9999 }}
      >
        {copied ? 'Copied!' : 'Copy Debug'}
      </button>

      <div className="w-full max-w-4xl mx-auto p-4">
        <h1 className="text-3xl font-bold text-center mb-6">E01 Parser</h1>

        {/* Status indicator */}
        <div className="text-xs text-gray-500 text-center mb-2">
          Last action: {lastAction}
        </div>

        <div
          onDrop={handleFileDrop}
          onDragOver={handleDragOver}
          className="border-2 border-dashed border-gray-400 rounded-lg p-8 text-center hover:border-blue-500 transition-colors cursor-pointer mb-6"
        >
          <input
            type="file"
            accept=".e01,.E01"
            onChange={handleFileSelect}
            className="hidden"
            id="file-input"
          />
          <label htmlFor="file-input" className="cursor-pointer">
            <div className="text-gray-600 dark:text-gray-300">
              <p className="text-lg mb-2">Drop an E01 file here or click to browse</p>
              <p className="text-sm text-gray-500">Supports .E01 (EnCase) files</p>
            </div>
          </label>
        </div>

        {loading && (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
            <p>Parsing E01 file...</p>
          </div>
        )}

        {result && !loading && (
          <div className="space-y-4">
            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 flex justify-between items-center">
              <div>
                <span className="font-medium">{fileName}</span>
                <span className="text-gray-500 ml-2">({formatBytes(fileSize)})</span>
              </div>
              <div className={`px-3 py-1 rounded-full text-sm font-medium ${result.valid ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                {result.valid ? 'Valid E01' : 'Invalid'}
              </div>
            </div>

            {result.debug && (
              <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-sm">
                <h3 className="font-medium text-blue-800 dark:text-blue-200 mb-2">Parse Info</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-blue-700 dark:text-blue-300">
                  <span>Duration: {result.debug.parseDuration ?? 0}ms</span>
                  <span>Sections: {result.debug.sectionsFound.length}</span>
                  <span>Chunks: {result.debug.chunksProcessed}</span>
                  <span>Logs: {result.debug.logs.length}</span>
                </div>
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <h3 className="font-medium text-red-800 dark:text-red-200 mb-2">Errors</h3>
                <ul className="list-disc list-inside text-red-700 dark:text-red-300 text-sm">
                  {result.errors.map((error, i) => (<li key={i}>{error}</li>))}
                </ul>
              </div>
            )}

            <div className="border-b border-gray-200 dark:border-gray-700">
              <nav className="flex space-x-4">
                {(['metadata', 'sections', 'files', 'hex'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`py-2 px-4 font-medium border-b-2 transition-colors ${activeTab === tab ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </nav>
            </div>

            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
              {activeTab === 'metadata' && (
                <div className="p-4 space-y-4">
                  <div>
                    <h3 className="font-medium text-lg mb-2">Case Information</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {Object.entries(result.metadata).length > 0 ? (
                        Object.entries(result.metadata).map(([key, value]) => (
                          <div key={key} className="contents">
                            <span className="text-gray-500 dark:text-gray-400">{key}:</span>
                            <span className="font-mono">{value || 'N/A'}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-gray-500 col-span-2">No metadata found in header</p>
                      )}
                    </div>
                  </div>

                  {result.volumeInfo && (
                    <div>
                      <h3 className="font-medium text-lg mb-2">Volume Information</h3>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <span className="text-gray-500">Media Type:</span>
                        <span className="font-mono">{result.volumeInfo.mediaType}</span>
                        <span className="text-gray-500">Chunk Count:</span>
                        <span className="font-mono">{result.volumeInfo.chunkCount}</span>
                        <span className="text-gray-500">Sectors per Chunk:</span>
                        <span className="font-mono">{result.volumeInfo.sectorsPerChunk}</span>
                        <span className="text-gray-500">Bytes per Sector:</span>
                        <span className="font-mono">{result.volumeInfo.bytesPerSector}</span>
                        <span className="text-gray-500">Total Sectors:</span>
                        <span className="font-mono">{result.volumeInfo.sectorCount?.toString()}</span>
                      </div>
                    </div>
                  )}

                  {result.hash && (
                    <div>
                      <h3 className="font-medium text-lg mb-2">Hash Values</h3>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        {result.hash.md5 && (<><span className="text-gray-500">MD5:</span><span className="font-mono text-xs break-all">{result.hash.md5}</span></>)}
                        {result.hash.sha1 && (<><span className="text-gray-500">SHA1:</span><span className="font-mono text-xs break-all">{result.hash.sha1}</span></>)}
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className="font-medium text-lg mb-2">File Signature</h3>
                    <div className="font-mono text-sm bg-gray-50 dark:bg-gray-800 p-2 rounded">
                      {Array.from(result.signature).map(b => b.toString(16).padStart(2, '0')).join(' ')}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'sections' && (
                <div className="p-4">
                  <h3 className="font-medium text-lg mb-2">Sections ({result.sections.length})</h3>
                  <div className="space-y-2">
                    {result.sections.map((section, i) => (
                      <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded p-3 text-sm">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="font-medium text-blue-600 dark:text-blue-400">{section.type.toUpperCase()}</span>
                            <span className="text-gray-500 ml-2">@ offset 0x{section.offset.toString(16)}</span>
                          </div>
                          <span className="text-gray-500">{formatBytes(Number(section.size))}</span>
                        </div>
                      </div>
                    ))}
                    {result.sections.length === 0 && <p className="text-gray-500">No sections found</p>}
                  </div>
                </div>
              )}

              {activeTab === 'files' && (
                <div className="p-4">
                  {partitionTable && (
                    <div className="mb-4">
                      <h3 className="font-medium text-lg mb-2">Partitions ({partitionTable.type})</h3>
                      <div className="space-y-2">
                        {partitionTable.partitions.length > 0 ? (
                          partitionTable.partitions.map((partition) => (
                            <div
                              key={partition.index}
                              className={`bg-gray-50 dark:bg-gray-800 rounded p-3 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${selectedPartition === partition.index ? 'ring-2 ring-blue-500' : ''}`}
                              onClick={() => parsePartitionFilesystem(partition)}
                            >
                              <div className="flex justify-between items-start">
                                <div>
                                  <span className="font-medium">Partition {partition.index}</span>
                                  {partition.name && <span className="text-gray-500 ml-2">({partition.name})</span>}
                                  <div className="text-gray-500 text-xs mt-1">
                                    {partition.type}
                                    {partition.filesystem && <span className="ml-2 text-blue-600 dark:text-blue-400">[{partition.filesystem}]</span>}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="text-gray-500">{formatBytes(Number(partition.sizeBytes))}</div>
                                  <div className="text-xs text-gray-400">LBA {partition.startLBA} - {partition.endLBA}</div>
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="text-gray-500">No partitions found</p>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-2">Click a partition to browse its files</p>
                    </div>
                  )}

                  {!partitionTable && result.rawDiskData && <p className="text-gray-500">Could not detect partition table</p>}
                  {!result.rawDiskData && <p className="text-gray-500">No raw disk data available for file browsing</p>}

                  {fsErrors.length > 0 && (
                    <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 mb-4">
                      <ul className="text-yellow-700 dark:text-yellow-300 text-sm">
                        {fsErrors.map((err, i) => (<li key={i}>{err}</li>))}
                      </ul>
                    </div>
                  )}

                  {parsingFiles && (
                    <div className="text-center py-4">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mx-auto mb-2"></div>
                      <p className="text-sm text-gray-500">Parsing filesystem...</p>
                    </div>
                  )}

                  {fatResult && fatResult.valid && !parsingFiles && (
                    <div>
                      <h3 className="font-medium text-lg mb-2">
                        Files ({fatResult.fatType})
                        {fatResult.bootSector?.volumeLabel && <span className="text-gray-500 ml-2 text-sm font-normal">- {fatResult.bootSector.volumeLabel}</span>}
                      </h3>
                      <div className="border rounded-lg dark:border-gray-700 max-h-96 overflow-y-auto">
                        {fatResult.rootEntries.length > 0 ? (
                          fatResult.rootEntries.map((entry, i) => (<FileTreeItem key={i} entry={entry} depth={0} />))
                        ) : (
                          <p className="text-gray-500 p-4">No files found</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'hex' && (
                <div className="p-4">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-medium text-lg">Hex Viewer</h3>
                    {result.rawDiskData && (
                      <div className="flex items-center gap-2 text-sm">
                        <button onClick={() => setHexOffset(Math.max(0, hexOffset - 256))} disabled={hexOffset === 0} className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded disabled:opacity-50">Prev</button>
                        <span className="text-gray-500">Offset: 0x{hexOffset.toString(16)} / {formatBytes(result.rawDiskData.length)}</span>
                        <button onClick={() => setHexOffset(Math.min(result.rawDiskData!.length - 256, hexOffset + 256))} disabled={hexOffset >= (result.rawDiskData?.length ?? 0) - 256} className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded disabled:opacity-50">Next</button>
                      </div>
                    )}
                  </div>
                  <div className="bg-gray-900 text-green-400 font-mono text-xs p-4 rounded overflow-x-auto">
                    {result.rawDiskData ? (<pre>{hexDump(result.rawDiskData, hexOffset, 256).join('\n')}</pre>) : (<p className="text-gray-500">No raw disk data extracted</p>)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
