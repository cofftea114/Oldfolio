import { BookOpenText, Inbox, Link2, RefreshCw, Send, Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';

interface CaptureItem { id: string; value: string; createdAt: string }

export function App() {
  const [value, setValue] = useState('');
  const [items, setItems] = useState<CaptureItem[]>([]);
  const today = useMemo(() => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date()), []);

  const capture = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setItems((current) => [{ id: crypto.randomUUID(), value: trimmed, createdAt: new Date().toISOString() }, ...current]);
    setValue('');
  };

  return (
    <main>
      <header><div className="brand">oldfolio</div><button aria-label="设置"><Settings2 /></button></header>
      <section className="hero"><p>{today}</p><h1>把想法带回<br />你的知识库。</h1></section>
      <section className="capture">
        <Link2 />
        <textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder="粘贴链接，或记下一段灵感…" />
        <button onClick={capture} aria-label="保存到收件箱"><Send /></button>
      </section>
      <section className="queue">
        <div className="section-title"><span>待处理</span><small><RefreshCw /> 桌面端打开后处理</small></div>
        {items.length ? items.map((item) => <article key={item.id}><Inbox /><div><strong>{item.value}</strong><small>等待 WebDAV 同步</small></div></article>) : <div className="empty"><BookOpenText /><p>捕获的内容会安全地进入本地 Inbox。</p></div>}
      </section>
      <nav><button className="active"><Inbox />收件箱</button><button><BookOpenText />知识库</button></nav>
    </main>
  );
}
