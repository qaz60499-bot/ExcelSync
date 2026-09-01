import type { ExcelSyncBridge } from '../../shared/contracts'

declare global {
  interface Window {
    excelSync: ExcelSyncBridge
  }
}

export {}
