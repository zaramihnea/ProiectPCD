import React, { useState, useEffect, useRef } from 'react';
import { Users, List, AlertTriangle, Activity, RefreshCw, Calendar, Power, PowerOff } from 'lucide-react';
import './App.css';

function App() {
  const [stats, setStats] = useState({
    subscriber: { totalAccesses: 0, totalCreated: 0, totalUpdated: 0, totalDeleted: 0, lastEventAt: null },
    list: { totalAccesses: 0, totalCreated: 0, totalUpdated: 0, totalDeleted: 0, lastEventAt: null },
    bounce: { totalAccesses: 0, totalCreated: 0, totalUpdated: 0, totalDeleted: 0, lastEventAt: null }
  });

  const [status, setStatus] = useState('connecting');
  const [latency, setLatency] = useState(0);
  const ws = useRef(null);
  const reconnectInterval = useRef(null);
  const manuallyClosed = useRef(false);
  const retryCount = useRef(0);

  const connectWebSocket = () => {
    if (reconnectInterval.current) clearTimeout(reconnectInterval.current);
    
    if (ws.current) {
        ws.current.onclose = null; 
        ws.current.close();
    }

    manuallyClosed.current = false;
    ws.current = new WebSocket('wss://websocket.proiectpcd.online/ws');

    ws.current.onopen = () => {
      console.log('WebSocket Connected');
      setStatus('connected');
      retryCount.current = 0;
    };

    ws.current.onmessage = (event) => {
      if (manuallyClosed.current) return;

      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'initial_state') {
          const initialState = {};
          console.log(initialState);
          message.data.forEach(item => {
            initialState[item.resourceType] = item;
          });
          setStats(prev => ({ ...prev, ...initialState }));
        } 
        else if (message.type === 'stats_updated') {
          const resource = message.resourceType;
          if (message.stats.lastEventAt) {
            const propagationTime = Date.now() - new Date(message.stats.lastEventAt).getTime();
            setLatency(propagationTime > 0 ? propagationTime : 0);
          }
          setStats(prev => ({ ...prev, [resource]: message.stats }));
        }
      } catch (err) {
        console.error('Data processing error:', err);
      }
    };

    ws.current.onclose = () => {
      if (!manuallyClosed.current) {
        setStatus('disconnected');
        
        const jitter = Math.random() * 500;
        const backoff = Math.min(Math.pow(2, retryCount.current) * 1000, 30000);
        const delay = backoff + jitter;

        console.warn(`⚠️ Connection lost. Retrying in ${(delay/1000).toFixed(1)}s (Attempt ${retryCount.current + 1})`);

        reconnectInterval.current = setTimeout(() => {
          retryCount.current++;
          connectWebSocket();
        }, delay);
      } else {
        setStatus('disconnected');
        console.log('🛑 Connection closed manually. Auto-reconnect disabled.');
      }
    };
  };

  const disconnectWebSocket = () => {
    manuallyClosed.current = true; 
    setStatus('disconnected');
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    if (reconnectInterval.current) clearTimeout(reconnectInterval.current);
  };

  useEffect(() => {
    connectWebSocket();
    return () => {
      manuallyClosed.current = true;
      if (ws.current) ws.current.close();
      if (reconnectInterval.current) clearTimeout(reconnectInterval.current);
    };
  }, []);

  return (
    <div className="dashboard-app">
      <nav className="side-nav">
        <div className="nav-logo">PCD</div>
        <div className="nav-items">
          <div className="nav-item active"><Activity size={20} /></div>
          <div className="nav-item" onClick={() => window.location.reload()} title="Reload"><RefreshCw size={20} /></div>
          
          <div 
            className={`nav-item ${status === 'connected' ? 'btn-disconnect' : 'btn-connect'}`} 
            onClick={status === 'connected' ? disconnectWebSocket : connectWebSocket}
            title={status === 'connected' ? "End Connection" : "Connect Now"}
          >
            {status === 'connected' ? <PowerOff size={20} color="#ef4444" /> : <Power size={20} color="#10b981" />}
          </div>
        </div>
      </nav>

      <div className="main-viewport">
        <header className="top-bar">
          <div className="header-info">
            <h1>Real-Time <span className="text-gradient">Analytics</span></h1>
            <p>Azure Service Bus & Cosmos DB Event Stream</p>
          </div>
          <div className="header-status">
            <div className={`connection-badge ${status}`}>
              <span className="pulse-dot"></span>
              {status === 'connected' ? 'LIVE' : status.toUpperCase()}
            </div>
          </div>
        </header>

        <main className="content-container">
          <div className="stats-layout">
            <div className="cards-row">
              <StatCard title="Subscribers" data={stats.subscriber} icon={Users} color="#3b82f6" />
              <StatCard title="Lists" data={stats.list} icon={List} color="#10b981" />
              <StatCard title="Bounces" data={stats.bounce} icon={AlertTriangle} color="#f59e0b" />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

const StatCard = ({ title, data, icon: Icon, color }) => {
  const formatTime = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="glass-card" style={{ '--accent-color': color }}>
      <div className="card-header">
        <Icon size={22} color={color} />
        <span className="card-title">{title}</span>
      </div>
      <div className="card-body">
        <div className="main-value">{(data?.totalAccesses || 0).toLocaleString()}</div>
        <div className="last-update">
          <Calendar size={12} />
          <span> Last Update: <strong>{formatTime(data?.lastEventAt)}</strong></span>
        </div>
        <div className="sub-values">
          <div className="sub-item"><span>Created</span><span className="val">{data?.totalCreated || 0}</span></div>
          <div className="sub-item"><span>Updated</span><span className="val">{data?.totalUpdated || 0}</span></div>
          <div className="sub-item"><span>Deleted</span><span className="val">{data?.totalDeleted || 0}</span></div>
        </div>
      </div>
    </div>
  );
};

export default App;