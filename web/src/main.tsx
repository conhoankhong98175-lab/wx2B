import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { AppLayout, AuthGate } from './layout.tsx';
import { CatalogPage } from './pages/CatalogPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { PublicQuotePage } from './pages/PublicQuotePage.tsx';
import { QuoteDetailPage } from './pages/QuoteDetailPage.tsx';
import { QuoteEditorPage } from './pages/QuoteEditorPage.tsx';
import { QuotesPage } from './pages/QuotesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('页面入口不存在');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/q/:token" element={<PublicQuotePage />} />
        <Route element={<AuthGate />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />
            <Route path="quotes" element={<QuotesPage />} />
            <Route path="quotes/new" element={<QuoteEditorPage />} />
            <Route path="quotes/:id" element={<QuoteDetailPage />} />
            <Route path="quotes/:id/edit" element={<QuoteEditorPage />} />
            <Route path="catalog" element={<CatalogPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
