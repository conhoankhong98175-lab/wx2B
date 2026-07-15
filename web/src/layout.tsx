import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { api, getToken, localLogin } from './api.ts';
import { Button, ErrorNotice, Loading } from './components.tsx';
import type { Merchant } from './types.ts';

export function AuthGate() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const enter = async () => {
    setError('');
    try {
      if (!getToken()) await localLogin();
      await api<Merchant>('/merchant');
      setReady(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法进入工具');
    }
  };

  useEffect(() => {
    void enter();
  }, []);

  if (ready) return <Outlet />;
  if (!error) return <Loading label="正在打开报价工作台…" />;
  return (
    <main className="login-screen">
      <div className="login-panel">
        <div className="brand-mark">店</div>
        <h1>店告报价助手</h1>
        <p>本地入口无需注册。线上服务器请从微信小程序登录。</p>
        <ErrorNotice message={error} />
        <Button onClick={() => void enter()}>重新进入</Button>
      </div>
    </main>
  );
}

const navigation = [
  { to: '/', label: '工作台', icon: '⌂', end: true },
  { to: '/quotes', label: '报价', icon: '▤' },
  { to: '/catalog', label: '价格库', icon: '▦' },
  { to: '/settings', label: '店铺设置', icon: '⚙' },
];

export function AppLayout() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">店</span>
          <span>
            <strong>店告</strong>
            <small>报价成交助手</small>
          </span>
        </div>
        <nav>
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end ?? false}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main-area">
        <header className="mobile-header">
          <button onClick={() => setMenuOpen((open) => !open)} aria-label="打开导航">
            ☰
          </button>
          <strong>店告报价助手</strong>
        </header>
        <main className="page-container">
          <Outlet />
        </main>
      </div>
      {menuOpen && (
        <button
          className="sidebar-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-label="关闭导航"
        />
      )}
    </div>
  );
}
