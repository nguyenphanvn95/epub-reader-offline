import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import EpubToAudiobook from './EpubToAudiobook.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EpubToAudiobook />
  </StrictMode>,
);
