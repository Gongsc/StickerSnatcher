import {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';

type Sticker = {id:string; pack:string; index:number; kind:'WEBP'|'WEBM'|'TGS'; emoji:string; thumb?:string};
type Pack = {name:string; title:string; stickers:Sticker[]};
type Item = Pick<Sticker,'pack'|'index'> & {status:string; error?:string};
type Job = {status:string; items:Item[]; archive?:boolean; folder?:string; can_open_folder?:boolean; error?:string};
type HistoryEntry = Pick<Pack, 'name' | 'title'>;
const historyKey = 'stickersnatcher.pack-history';
const packLink = (name:string) => `https://t.me/addstickers/${name}`;

function loadHistory(): HistoryEntry[] {
  try {
    const entries:unknown = JSON.parse(localStorage.getItem(historyKey) || '[]');
    if (Array.isArray(entries)) {
      return entries.filter(entry => entry && typeof entry.title === 'string'
        && typeof entry.name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(entry.name)).slice(0, 30);
    }
  } catch {
    // The app can still import packs when browser storage is unavailable.
  }
  return [];
}

const key = (s:Pick<Sticker,'pack'|'index'>) => s.pack + '/' + s.index;
const message = (e:unknown) => e instanceof Error ? e.message : '操作失败';
async function post(path:string, body:object) {
  const result = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if (!result.ok) {
    const detail = (await result.json().catch(() => ({}))).detail;
    throw new Error(typeof detail === 'string' ? detail : '请求失败，请检查输入或本地服务');
  }
  return result;
}
function Preview({sticker, token, proxy}: {sticker:Sticker; token:string; proxy:string}) {
  const [animated, animate] = useState(sticker.kind !== 'WEBP');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [attempt, retry] = useState(0);
  const [visible, setVisible] = useState(false);
  const tile = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!tile.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(tile.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const observer = new AbortController();
    let objectUrl = '';
    const thumb = !animated && sticker.thumb;
    setLoading(true);
    setFailure('');
    setUrl('');
    fetch('/api/preview', {method:'POST', signal:observer.signal, headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token, proxy:proxy || null, id:thumb || sticker.id, kind:thumb ? 'WEBP' : sticker.kind, still:!animated})})
      .then(async response => {
        if (response.ok) return response.blob();
        const error = await response.json().catch(() => ({}));
        throw new Error(typeof error.detail === 'string' ? error.detail : '预览加载失败');
      })
      .then(blob => {
        if (!observer.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(error => {
        if (!observer.signal.aborted) setFailure(message(error));
      })
      .finally(() => {
        if (!observer.signal.aborted) setLoading(false);
      });
    return () => {
      observer.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [animated, attempt, sticker, token, proxy, visible]);
  const dynamic = sticker.kind !== 'WEBP';
  const action = animated ? (failure ? '重试播放' : loading ? '取消加载' : '停止播放') : '播放动图';

  return <>
    <button ref={tile} className="preview" type="button" disabled={!dynamic}
      aria-label={dynamic ? action : '静态贴纸预览'}
      aria-busy={loading}
      onClick={() => {
        if (animated && failure) retry(value => value + 1);
        else animate(!animated);
      }}>
      {url ? <img src={url} alt={sticker.emoji || '贴纸'} onError={() => {
        setUrl('');
        setFailure('浏览器无法显示预览');
      }}/> : <span>{sticker.emoji || '▧'}</span>}
      {dynamic && <small className="preview-action">{animated && loading ? '加载中…' : action}</small>}
    </button>
    {dynamic && animated && failure && <div className="preview-error" role="status">{failure}</div>}
  </>;

}

function App() {
  const [cloud, setCloud] = useState<boolean>();
  useEffect(() => {
    fetch('/api/settings')
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(settings => setCloud(settings.cloud === true))
      .catch(() => {});
  }, []);
  const [token, setToken] = useState('');
  const [proxy, setProxy] = useState('');
  const [connection, setConnection] = useState({token:'', proxy:''});
  const [links, setLinks] = useState('');
  const [history, setHistory] = useState(loadHistory);
  const [clearingCache, setClearingCache] = useState(false);
  const [notice, setNotice] = useState('');
  const tokenInput = useRef<HTMLInputElement>(null);
  const selectionPanel = useRef<HTMLElement>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'normal'|'qq'>('normal');
  const [edge, setEdge] = useState(256);
  const [budget, setBudget] = useState(500);
  const [transparent, setTransparent] = useState(true);
  const [color, setColor] = useState('#ffffff');
  const [still, setStill] = useState(false);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<Job>();
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const stickers = packs.flatMap(p => p.stickers);
  const chosen = stickers.filter(s => selected.has(key(s)));
  const finished = job?.items.filter(i => ['failed','done','cancelled'].includes(i.status)).length ?? 0;
  const failed = job?.items.filter(i => i.status === 'failed') ?? [];

  useEffect(() => {
    if (!jobId || (job && job.status !== 'running')) return;
    let active = true;
    async function poll() {
      try {
        const response = await fetch('/api/jobs/' + jobId);
        if (!response.ok) throw new Error('无法读取导出进度');
        const state:Job = await response.json();
        if (active) {
          setJob(state);
          setBusy(state.status === 'running');
        }
      } catch (e) {
        if (active) setError(message(e));
      }
    }
    void poll();
    const timer = window.setInterval(poll, 800);
    return () => {active = false; window.clearInterval(timer);};
  }, [jobId, job?.status]);

  function saveHistory(entries:HistoryEntry[]) {
    try {
      if (entries.length) localStorage.setItem(historyKey, JSON.stringify(entries));
      else localStorage.removeItem(historyKey);
      setHistory(entries);
    } catch {
      setHistory(entries);
      setNotice('浏览器存储不可用，历史记录的变更可能无法保留。');
      return false;
    }
    return true;
  }

  async function clearCache() {
    setClearingCache(true);
    setError('');
    setNotice('');
    try {
      const response = await post('/api/cache/clear', {token:cloud ? token.trim() : null});
      const {removed} = await response.json();
      setNotice(removed ? `已清除 ${removed} 个缓存文件。` : '没有需要清除的缓存。');
    } catch (e) {setError(message(e));}
    finally {setClearingCache(false);}
  }

  async function importLinks(source = links, fromHistory = false) {
    if (busy || importing || clearingCache) return;
    if (!token.trim()) {
      setError('请先填写 Bot Token。');
      tokenInput.current?.focus();
      return;
    }
    setNotice('');
    setImporting(true);
    setError('');
    try {
      const credentials = {token:token.trim(), proxy:cloud === false ? proxy.trim() : ''};
      const result = await post('/api/import', {...credentials, proxy:credentials.proxy || null, links:source.trim().split(/\s+/)});
      const data:{packs:Pack[]; errors:string[]} = await result.json();
      if (data.packs.length) {
        const latest = data.packs.map(({name, title}) => ({name, title}));
        const seen = new Set(latest.map(pack => pack.name.toLowerCase()));
        saveHistory([...latest, ...history.filter(pack => !seen.has(pack.name.toLowerCase()))].slice(0, 30));
        setConnection(credentials);
        setPacks(data.packs);
        setSelected(new Set(data.packs.flatMap(p => p.stickers.map(key))));
        setJob(undefined);
        setJobId('');
        if (fromHistory) requestAnimationFrame(() => selectionPanel.current?.scrollIntoView({block:'start'}));
      }
      setError(data.errors.join('；'));
    } catch (e) {setError(message(e));}
    finally {setImporting(false);}
  }

  async function start(items:Sticker[]) {
    setBusy(true);
    setError('');
    try {
      const response = await post('/api/jobs', {token:connection.token, proxy:connection.proxy || null,
        stickers:items, mode, edge, max_kb:budget, background:transparent ? 'transparent' : color, still});
      const {id} = await response.json();
      setJob(undefined);
      setJobId(id);
    } catch (e) {setError(message(e)); setBusy(false);}
  }

  return <main>
    <header><div className="brand">Sticker<span>Snatcher</span></div><span className="badge">{cloud ? '云端模式' : '本地工具'}</span></header>
    <form className="panel" onSubmit={event => {event.preventDefault(); void importLinks();}}>
      <h2><b>01</b> 导入表情包</h2>
      <details className="guide">
        <summary>使用指南 · 获取链接到导出</summary>
        <ol>
          <li><strong>获取 Bot Token。</strong>在 Telegram 打开 <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>，发送 <code>/newbot</code>，按提示创建机器人。复制返回的 Token，填入下方输入框。{cloud === false && '连接 Telegram 需要代理时，再填写代理地址。'}</li>
          <li><strong>复制表情包链接。</strong>在聊天里点开一张贴纸。若没有打开整套预览，手机上长按、电脑上右键，选择「查看表情包」。在预览里的分享按钮或 <code>⋯</code> 菜单中选「复制链接」。</li>
          <li><strong>导入并勾选。</strong>粘贴 <code>https://t.me/addstickers/…</code> 链接，每行一个，点击「读取表情包」。默认全选，可按表情包展开预览并调整勾选。动态贴纸进入可见区域时自动播放，可点击暂停。</li>
          <li><strong>选择格式并导出。</strong>普通模式保留原尺寸。静态贴纸保存为 PNG，动态贴纸可选 GIF 或首帧 PNG。{cloud === false ? '导出后可打开文件夹或下载 ZIP。' : '导出后下载 ZIP。'}</li>
          <li><strong>添加到 QQ。</strong>选择「QQ 表情适配」再导出。如果下载的是 ZIP，先解压，然后在 QQ 的自定义表情面板中添加 PNG 或 GIF 文件。</li>
        </ol>
        <p className="hint">想先试一下？<button type="button" className="example" onClick={() => {
          const example = 'https://t.me/addstickers/UtyaDuck';
          setLinks(current => current.split(/\s+/).includes(example) ? current : [current.trim(), example].filter(Boolean).join('\n'));
        }}>填入示例链接</button></p>
      </details>
      <div className="fields">
        <label>Bot Token<input ref={tokenInput} type="password" required value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="从 Telegram @BotFather 获取"/></label>
        {cloud === false && <label>代理地址（可选）<input type="text" value={proxy} onChange={e => setProxy(e.target.value)} placeholder="例如 socks5://127.0.0.1:1080"/></label>}
      </div>
      <label>Telegram 表情包链接<textarea required value={links} onChange={e => setLinks(e.target.value)} placeholder="https://t.me/addstickers/…（每行一个链接）" rows={3}/></label>
      <button className="primary" disabled={busy || importing || clearingCache}>{importing ? '正在导入…' : '读取表情包'}</button>
    </form>
    <section className="panel">
      <div className="section-head">
        <h2>表情包历史</h2>
        <div className="actions">
          <button disabled={!history.length || importing} onClick={() => {
            setError('');
            setNotice('');
            if (saveHistory([])) setNotice('已清除表情包历史。');
          }}>清除历史</button>
          <button disabled={cloud === undefined || importing || busy || clearingCache || (cloud && !token.trim())}
            onClick={() => void clearCache()}>{clearingCache ? '正在清除…' : '清除缓存'}</button>
        </div>
      </div>
      <p className="hint">历史记录保存在当前浏览器。{cloud ? '填写 Bot Token 后可清除该机器人的素材缓存。' : '清除缓存会删除已下载的贴纸素材。'}已导出的文件会保留。</p>
      {notice && <p role="status">{notice}</p>}
      {history.length ? <ul className="history">{history.map(pack => <li key={pack.name.toLowerCase()}>
        <div><strong>{pack.title}</strong><small>{packLink(pack.name)}</small></div>
        <button disabled={importing || busy || clearingCache} onClick={() => {
          const link = packLink(pack.name);
          setLinks(link);
          void importLinks(link, true);
        }}>重新预览</button>
      </li>)}</ul> : <p className="empty">成功导入的表情包会显示在这里。</p>}
    </section>
    {error && <p role="alert" className="error">{error}</p>}
    <section ref={selectionPanel} className="panel">
      <div className="section-head"><h2><b>02</b> 选择表情</h2><span className="badge">已选 {chosen.length} / {stickers.length}</span></div>
      {!packs.length && <p className="empty">导入表情包后，在这里预览和勾选。</p>}
      {!!packs.length && <div className="actions">
        <button onClick={() => setSelected(new Set(stickers.map(key)))}>全选</button>
        <button onClick={() => setSelected(new Set())}>清空选择</button>
      </div>}
      {packs.map(pack => <details className="pack" key={pack.name} open={packs.length === 1}>
        <summary>
          <strong>{pack.title}</strong>
          <span className="badge">已选 {pack.stickers.filter(sticker => selected.has(key(sticker))).length} / {pack.stickers.length}</span>
        </summary>
        <div className="grid">{pack.stickers.map(s => <div key={key(s)} className={selected.has(key(s)) ? 'tile selected' : 'tile'}>
          <Preview sticker={s} {...connection}/>
          <label><input type="checkbox" checked={selected.has(key(s))} onChange={e => {
            const next = new Set(selected);
            if (e.target.checked) next.add(key(s)); else next.delete(key(s));
            setSelected(next);
          }}/><span>#{s.index} · {s.kind}</span></label>
        </div>)}</div>
      </details>)}
    </section>
    <section className="panel">
      <h2><b>03</b> 导出设置</h2>
      <fieldset><legend>导出模式</legend><div className="fields">
        <label className="option"><input type="radio" name="mode" checked={mode === 'normal'} onChange={() => setMode('normal')}/> 普通图片 / GIF</label>
        <label className="option"><input type="radio" name="mode" checked={mode === 'qq'} onChange={() => setMode('qq')}/> QQ 表情适配</label>
      </div></fieldset>
      {mode === 'qq' && <div className="fields">
        <label>画布尺寸<select value={edge} onChange={e => setEdge(Number(e.target.value))}>{[128,256,512].map(n => <option key={n}>{n}</option>)}</select></label>
        <label>GIF 目标上限（KB）<input type="number" min={32} max={5000} value={budget} onChange={e => setBudget(Number(e.target.value))}/></label>
      </div>}
      <div className="fields">
        <label>动态贴纸<select value={still ? 'png' : 'gif'} onChange={e => setStill(e.target.value === 'png')}><option value="gif">保留动画（GIF）</option><option value="png">只导出首帧（PNG）</option></select></label>
        <label>背景<select value={transparent ? 'transparent' : 'solid'} onChange={e => setTransparent(e.target.value === 'transparent')}><option value="transparent">透明</option><option value="solid">纯色</option></select></label>
        {!transparent && <label>背景色<input type="color" value={color} onChange={e => setColor(e.target.value)}/></label>}
      </div>
      {mode === 'qq' && <p className="hint">解压后在 QQ 的自定义表情面板中添加 PNG / GIF 文件。</p>}
      <button className="primary" disabled={busy || importing || clearingCache || !chosen.length} onClick={() => void start(chosen)}>导出 {chosen.length} 张表情</button>
    </section>
    {jobId && <section className="panel" aria-live="polite">
      <h2>导出进度</h2>
      <progress value={finished} max={job?.items.length || 1}/>
      <p>{finished} / {job?.items.length ?? 0} · {busy ? '处理中' : job?.status === 'cancelled' ? '已取消' : job?.error || '处理完成'}{failed.length ? ' · 失败 ' + failed.length : ''}</p>
      <div className="actions">
        {busy && <button disabled={job?.status !== 'running'} onClick={() => void post('/api/jobs/' + jobId + '/cancel', {}).catch(e => setError(message(e)))}>取消导出</button>}
        {job?.archive && <a className="primary" href={'/api/jobs/' + jobId + '/zip'}>下载 ZIP</a>}
        {job?.folder && job.can_open_folder !== false && <button onClick={() => void post('/api/jobs/' + jobId + '/open', {}).catch(e => setError(message(e)))}>打开文件夹</button>}
        {!busy && !!failed.length && <button onClick={() => void start(stickers.filter(s => failed.some(i => key(i) === key(s))))}>重试失败项</button>}
      </div>
      {job?.folder && <p className="hint path">{job.can_open_folder === false ? '容器导出目录' : '本地目录'} {job.folder}</p>}
      {!!failed.length && <details><summary>查看失败原因</summary><ul>{failed.map(item => <li key={key(item)}>{key(item)} · {item.error}</li>)}</ul></details>}
    </section>}
    <footer>StickerSnatcher{cloud ? ' · 导出后下载 ZIP' : ' · 贴纸与导出文件保存在本机'}</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
