import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Card({
  title,
  action,
  className = '',
  children,
}: PropsWithChildren<{ title?: string; action?: ReactNode; className?: string }>) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-header">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: PropsWithChildren<{ label: string; hint?: string; className?: string }>) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function EmptyState({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark">⌁</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Loading({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return <div className="notice notice-error">{message}</div>;
}

export function StatusPill({ state, label }: { state: string; label: string }) {
  return <span className={`status-pill status-${state.toLowerCase()}`}>{label}</span>;
}
