import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ObservatoryWorkbench } from '../client/ObservatoryPanel.tsx'
import { demoSnapshot } from './demo-data.ts'
import './demo.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Demo root element is missing')

createRoot(root).render(
  <StrictMode>
    <ObservatoryWorkbench snapshot={demoSnapshot} />
  </StrictMode>,
)
