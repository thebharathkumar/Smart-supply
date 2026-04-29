import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OperationsMap } from './views/OperationsMap';
import { ForecastView } from './views/ForecastView';
import { AgentConsole } from './views/AgentConsole';
import { NetworkGraph } from './views/NetworkGraph';
import { ws } from './lib/ws';

export function App() {
  useEffect(() => {
    ws.start();
    return () => ws.stop();
  }, []);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<OperationsMap />} />
        <Route path="/network" element={<NetworkGraph />} />
        <Route path="/forecast" element={<ForecastView />} />
        <Route path="/agent" element={<AgentConsole />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
