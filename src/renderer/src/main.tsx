import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (!window.excelSync) {
  root.render(
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 32, fontFamily: 'Segoe UI, sans-serif', background: '#f4f7fb' }}>
      <section style={{ width: 560, maxWidth: '100%', background: 'white', border: '1px solid #dce3ed', borderRadius: 16, padding: 28 }}>
        <h1 style={{ marginTop: 0 }}>ExcelSync 启动失败</h1>
        <p>本地桥接组件没有加载成功。请完全退出 ExcelSync 后重新打开。</p>
        <p style={{ color: '#667085' }}>错误：PRELOAD_BRIDGE_UNAVAILABLE</p>
      </section>
    </main>
  )
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
