import { NavLink, Outlet } from 'react-router-dom';
import { useWsStore } from '../lib/ws';

const NAV = [
  { to: '/', label: 'Operations Map' },
  { to: '/network', label: 'Network' },
  { to: '/forecast', label: 'Forecast' },
  { to: '/agent', label: 'Agent Console' },
];

export function Layout() {
  const status = useWsStore((s) => s.status);
  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-6 px-6 py-3 border-b border-ink-800 bg-ink-900">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-accent-400" />
          <span className="font-mono text-sm tracking-wider">SMART · SUPPLY</span>
        </div>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md text-sm transition ${
                  isActive ? 'bg-ink-800 text-accent-400' : 'text-ink-100/70 hover:text-ink-50'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              status === 'open'
                ? 'bg-accent-400'
                : status === 'connecting'
                  ? 'bg-yellow-400'
                  : 'bg-red-400'
            }`}
          />
          <span className="font-mono text-ink-100/60">ws · {status}</span>
        </div>
      </header>
      <main className="flex-1 min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
