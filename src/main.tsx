import { render } from 'preact'
import { App } from './app'
import { initNotes } from './state/notes'
import './ui/styles.css'

// Started before mounting: the notes store refuses to write until this settles, so
// the sooner it does, the smaller the window in which the notes view is read-only.
void initNotes()

const root = document.getElementById('app')
if (!root) throw new Error('no #app element to mount into')
render(<App />, root)
