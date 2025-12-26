'use client';

import { useState, useCallback } from 'react';
import {
  parseE01,
  E01ParseResult,
  hexDump,
  formatBytes,
} from '@/lib/e01-parser';

export default function E01Viewer() {
  const [result, setResult] = useState<E01ParseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<number>(0);
  const [hexOffset, setHexOffset] = useState(0);
  const [activeTab, setActiveTab] = useState<'metadata' | 'sections' | 'hex'>('metadata');

  const handleFileDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      await processFile(file);
    }
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await processFile(file);
    }
  }, []);

  const processFile = async (file: File) => {
    setLoading(true);
    setFileName(file.name);
    setFileSize(file.size);
    setHexOffset(0);

    try {
      const parseResult = await parseE01(file);
      setResult(parseResult);
    } catch (error) {
      setResult({
        valid: false,
        signature: new Uint8Array(8),
        sections: [],
        metadata: {},
        volumeInfo: null,
        rawDiskData: null,
        errors: [`Failed to parse file: ${error instanceof Error ? error.message : String(error)}`],
      });
    }

    setLoading(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-4">
      {/* Header */}
      <h1 className="text-3xl font-bold text-center mb-6">E01 Parser</h1>

      {/* File Upload Area */}
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

      {/* Loading State */}
      {loading && (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
          <p>Parsing E01 file...</p>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">
          {/* File Info Bar */}
          <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 flex justify-between items-center">
            <div>
              <span className="font-medium">{fileName}</span>
              <span className="text-gray-500 ml-2">({formatBytes(fileSize)})</span>
            </div>
            <div className={`px-3 py-1 rounded-full text-sm font-medium ${result.valid ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
              {result.valid ? 'Valid E01' : 'Invalid'}
            </div>
          </div>

          {/* Errors */}
          {result.errors.length > 0 && (
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <h3 className="font-medium text-red-800 dark:text-red-200 mb-2">Errors</h3>
              <ul className="list-disc list-inside text-red-700 dark:text-red-300 text-sm">
                {result.errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Tabs */}
          <div className="border-b border-gray-200 dark:border-gray-700">
            <nav className="flex space-x-4">
              {(['metadata', 'sections', 'hex'] as const).map((tab) => (
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

          {/* Tab Content */}
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
            {/* Metadata Tab */}
            {activeTab === 'metadata' && (
              <div className="p-4 space-y-4">
                {/* Case Metadata */}
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

                {/* Volume Info */}
                {result.volumeInfo && (
                  <div>
                    <h3 className="font-medium text-lg mb-2">Volume Information</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500 dark:text-gray-400">Media Type:</span>
                      <span className="font-mono">{result.volumeInfo.mediaType}</span>
                      <span className="text-gray-500 dark:text-gray-400">Chunk Count:</span>
                      <span className="font-mono">{result.volumeInfo.chunkCount}</span>
                      <span className="text-gray-500 dark:text-gray-400">Sectors per Chunk:</span>
                      <span className="font-mono">{result.volumeInfo.sectorsPerChunk}</span>
                      <span className="text-gray-500 dark:text-gray-400">Bytes per Sector:</span>
                      <span className="font-mono">{result.volumeInfo.bytesPerSector}</span>
                      <span className="text-gray-500 dark:text-gray-400">Total Sectors:</span>
                      <span className="font-mono">{result.volumeInfo.sectorCount?.toString()}</span>
                    </div>
                  </div>
                )}

                {/* Hash Info */}
                {result.hash && (
                  <div>
                    <h3 className="font-medium text-lg mb-2">Hash Values</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {result.hash.md5 && (
                        <>
                          <span className="text-gray-500 dark:text-gray-400">MD5:</span>
                          <span className="font-mono text-xs break-all">{result.hash.md5}</span>
                        </>
                      )}
                      {result.hash.sha1 && (
                        <>
                          <span className="text-gray-500 dark:text-gray-400">SHA1:</span>
                          <span className="font-mono text-xs break-all">{result.hash.sha1}</span>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Signature */}
                <div>
                  <h3 className="font-medium text-lg mb-2">File Signature</h3>
                  <div className="font-mono text-sm bg-gray-50 dark:bg-gray-800 p-2 rounded">
                    {Array.from(result.signature).map(b => b.toString(16).padStart(2, '0')).join(' ')}
                  </div>
                </div>
              </div>
            )}

            {/* Sections Tab */}
            {activeTab === 'sections' && (
              <div className="p-4">
                <h3 className="font-medium text-lg mb-2">Sections ({result.sections.length})</h3>
                <div className="space-y-2">
                  {result.sections.map((section, i) => (
                    <div
                      key={i}
                      className="bg-gray-50 dark:bg-gray-800 rounded p-3 text-sm"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <span className="font-medium text-blue-600 dark:text-blue-400">
                            {section.type.toUpperCase()}
                          </span>
                          <span className="text-gray-500 ml-2">
                            @ offset 0x{section.offset.toString(16)}
                          </span>
                        </div>
                        <span className="text-gray-500">
                          {formatBytes(Number(section.size))}
                        </span>
                      </div>
                    </div>
                  ))}
                  {result.sections.length === 0 && (
                    <p className="text-gray-500">No sections found</p>
                  )}
                </div>
              </div>
            )}

            {/* Hex Tab */}
            {activeTab === 'hex' && (
              <div className="p-4">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-medium text-lg">Hex Viewer</h3>
                  {result.rawDiskData && (
                    <div className="flex items-center gap-2 text-sm">
                      <button
                        onClick={() => setHexOffset(Math.max(0, hexOffset - 256))}
                        disabled={hexOffset === 0}
                        className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded disabled:opacity-50"
                      >
                        ← Prev
                      </button>
                      <span className="text-gray-500">
                        Offset: 0x{hexOffset.toString(16)} / {formatBytes(result.rawDiskData.length)}
                      </span>
                      <button
                        onClick={() => setHexOffset(Math.min(result.rawDiskData!.length - 256, hexOffset + 256))}
                        disabled={hexOffset >= (result.rawDiskData?.length ?? 0) - 256}
                        className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded disabled:opacity-50"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>
                <div className="bg-gray-900 text-green-400 font-mono text-xs p-4 rounded overflow-x-auto">
                  {result.rawDiskData ? (
                    <pre>
                      {hexDump(result.rawDiskData, hexOffset, 256).join('\n')}
                    </pre>
                  ) : (
                    <p className="text-gray-500">No raw disk data extracted</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
