export type FileCategory = 'spreadsheet' | 'document' | 'archive' | 'structured' | 'presentation' | 'image' | 'binary'
export type FilePartition = 'excel' | 'csv' | 'pdf' | 'word' | 'text' | 'zip' | 'json' | 'xml-yaml' | 'pptx' | 'image' | 'executable'

export interface ManagedFileType {
  extension: string
  category: FileCategory
  mimeType: string
  parser: 'spreadsheet' | 'text' | 'pdf' | 'office-zip' | 'archive' | 'structured-text' | 'image' | 'legacy-binary' | 'binary'
}

const TYPES: ManagedFileType[] = [
  { extension: '.xlsx', category: 'spreadsheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parser: 'office-zip' },
  { extension: '.xlsm', category: 'spreadsheet', mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', parser: 'office-zip' },
  { extension: '.xls', category: 'spreadsheet', mimeType: 'application/vnd.ms-excel', parser: 'legacy-binary' },
  { extension: '.xlsb', category: 'spreadsheet', mimeType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', parser: 'office-zip' },
  { extension: '.csv', category: 'spreadsheet', mimeType: 'text/csv; charset=utf-8', parser: 'text' },
  { extension: '.tsv', category: 'spreadsheet', mimeType: 'text/tab-separated-values; charset=utf-8', parser: 'text' },

  { extension: '.pdf', category: 'document', mimeType: 'application/pdf', parser: 'pdf' },
  { extension: '.docx', category: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', parser: 'office-zip' },
  { extension: '.txt', category: 'document', mimeType: 'text/plain; charset=utf-8', parser: 'text' },
  { extension: '.md', category: 'document', mimeType: 'text/markdown; charset=utf-8', parser: 'text' },
  { extension: '.rtf', category: 'document', mimeType: 'application/rtf', parser: 'text' },

  { extension: '.zip', category: 'archive', mimeType: 'application/zip', parser: 'archive' },

  { extension: '.json', category: 'structured', mimeType: 'application/json; charset=utf-8', parser: 'structured-text' },
  { extension: '.jsonl', category: 'structured', mimeType: 'application/x-ndjson; charset=utf-8', parser: 'structured-text' },
  { extension: '.xml', category: 'structured', mimeType: 'application/xml; charset=utf-8', parser: 'structured-text' },
  { extension: '.yaml', category: 'structured', mimeType: 'application/yaml; charset=utf-8', parser: 'structured-text' },
  { extension: '.yml', category: 'structured', mimeType: 'application/yaml; charset=utf-8', parser: 'structured-text' },

  { extension: '.pptx', category: 'presentation', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', parser: 'office-zip' },

  { extension: '.png', category: 'image', mimeType: 'image/png', parser: 'image' },
  { extension: '.jpg', category: 'image', mimeType: 'image/jpeg', parser: 'image' },
  { extension: '.jpeg', category: 'image', mimeType: 'image/jpeg', parser: 'image' },
  { extension: '.webp', category: 'image', mimeType: 'image/webp', parser: 'image' },
  { extension: '.bmp', category: 'image', mimeType: 'image/bmp', parser: 'image' },
  { extension: '.tif', category: 'image', mimeType: 'image/tiff', parser: 'image' },
  { extension: '.tiff', category: 'image', mimeType: 'image/tiff', parser: 'image' },

  { extension: '.exe', category: 'binary', mimeType: 'application/vnd.microsoft.portable-executable', parser: 'binary' }
]

const TYPE_BY_EXTENSION = new Map(TYPES.map((type) => [type.extension, type]))

export const SUPPORTED_FILE_EXTENSIONS = TYPES.map((type) => type.extension)
export const SUPPORTED_DIALOG_EXTENSIONS = SUPPORTED_FILE_EXTENSIONS.map((extension) => extension.slice(1))

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  spreadsheet: '表格',
  document: '文档',
  archive: '压缩包',
  structured: '结构化数据',
  presentation: '演示文稿',
  image: '图片',
  binary: '二进制文件'
}

export const FILE_CATEGORY_ORDER: FileCategory[] = ['spreadsheet', 'document', 'archive', 'structured', 'presentation', 'image', 'binary']

export const FILE_PARTITIONS: ReadonlyArray<{ id: FilePartition; label: string; extensions: readonly string[] }> = [
  { id: 'excel', label: 'Excel', extensions: ['.xlsx', '.xlsm', '.xls', '.xlsb'] },
  { id: 'csv', label: 'CSV / TSV', extensions: ['.csv', '.tsv'] },
  { id: 'pdf', label: 'PDF', extensions: ['.pdf'] },
  { id: 'word', label: 'Word / RTF', extensions: ['.docx', '.rtf'] },
  { id: 'text', label: 'TXT / Markdown', extensions: ['.txt', '.md'] },
  { id: 'zip', label: 'ZIP', extensions: ['.zip'] },
  { id: 'json', label: 'JSON', extensions: ['.json', '.jsonl'] },
  { id: 'xml-yaml', label: 'XML / YAML', extensions: ['.xml', '.yaml', '.yml'] },
  { id: 'pptx', label: 'PPTX', extensions: ['.pptx'] },
  { id: 'image', label: '图片', extensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'] },
  { id: 'executable', label: 'EXE', extensions: ['.exe'] }
]

const PARTITION_BY_EXTENSION = new Map(FILE_PARTITIONS.flatMap((partition) => partition.extensions.map((extension) => [extension, partition] as const)))

function extensionFromName(name: string): string {
  const clean = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const index = clean.lastIndexOf('.')
  return index >= 0 ? clean.slice(index) : ''
}

export function fileTypeForName(name: string): ManagedFileType | null {
  return TYPE_BY_EXTENSION.get(extensionFromName(name)) ?? null
}

export function isSupportedFileName(name: string): boolean {
  return fileTypeForName(name) !== null
}

export function mimeForFileName(name: string): string {
  return fileTypeForName(name)?.mimeType ?? 'application/octet-stream'
}

export function fileCategoryForName(name: string): FileCategory | null {
  return fileTypeForName(name)?.category ?? null
}

export function filePartitionForName(name: string): FilePartition | null {
  return PARTITION_BY_EXTENSION.get(extensionFromName(name))?.id ?? null
}

export function filePartitionLabel(name: string): string {
  return PARTITION_BY_EXTENSION.get(extensionFromName(name))?.label ?? '其他'
}

function bytesStartWith(bytes: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let output = ''
  for (let index = start; index < Math.min(end, bytes.length); index += 1) output += String.fromCharCode(bytes[index] ?? 0)
  return output
}

export function matchesExpectedFileSignature(name: string, bytes: Uint8Array): boolean {
  const type = fileTypeForName(name)
  if (!type) return false
  const extension = type.extension
  if (['.xlsx', '.xlsm', '.xlsb', '.docx', '.pptx', '.zip'].includes(extension)) {
    return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  }
  if (extension === '.pdf') return ascii(bytes, 0, 5) === '%PDF-'
  if (extension === '.xls') return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  if (extension === '.exe') return ascii(bytes, 0, 2) === 'MZ'
  if (extension === '.rtf') return ascii(bytes, 0, 5).toLowerCase() === '{\\rtf'
  if (extension === '.png') return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (extension === '.jpg' || extension === '.jpeg') return bytesStartWith(bytes, [0xff, 0xd8, 0xff])
  if (extension === '.webp') return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
  if (extension === '.bmp') return ascii(bytes, 0, 2) === 'BM'
  if (extension === '.tif' || extension === '.tiff') {
    return bytesStartWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || bytesStartWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  }
  if (['text', 'structured-text'].includes(type.parser)) return !bytes.includes(0)
  return true
}

export function extensionLabel(name: string): string {
  return fileTypeForName(name)?.extension.toUpperCase().slice(1) ?? 'FILE'
}
