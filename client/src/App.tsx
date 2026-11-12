import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Send, Search, Users, LogOut, Shield, Wifi, PanelRight, Paperclip, Bell, Settings, UserRound, Pencil, Trash2, Reply, Flag, FileText } from 'lucide-react';
import { decryptFile, decryptText, encryptFile, encryptText, ensureIdentity, getConversationKey } from './crypto';

const env = (import.meta as any).env;
const API: string = env.VITE_API ?? ''; // set VITE_API=http://localhost:4001 to talk to the 2nd instance

const api = async (path: string, token?: string, body?: any, method?: string) => {
  const r = await fetch(API + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};

const apiForm = async (path: string, token: string, data: FormData) => {
  const r = await fetch(API + path, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: data });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Upload failed');
  return j;
};

const inp = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600';

function Auth({ onAuth }: any) {
  const [reg, setReg] = useState(false);
  const [f, setF] = useState<any>({});
  const [err, setErr] = useState('');
  const [campuses, setCampuses] = useState<any[]>([]);
  useEffect(() => { api('/api/auth/campuses').then(setCampuses).catch(() => {}); }, []);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const fields = reg
    ? [['fullName', 'Full name'], ['username', 'Username'], ['email', 'Email'], ['faculty', 'Faculty'], ['department', 'Department']]
    : [['login', 'Username or email']];
  const submit = async (e: any) => {
    e.preventDefault();
    try { onAuth(await api(reg ? '/api/auth/register' : '/api/auth/login', undefined, { ...f, campusId: f.campusId ? +f.campusId : null })); }
    catch (x: any) { setErr(x.message); }
  };
  return (
    <div className="min-h-screen grid place-items-center bg-emerald-900 p-4">
      <form onSubmit={submit} className="bg-white p-8 rounded-xl w-full max-w-sm space-y-3">
        <h1 className="text-2xl font-bold text-emerald-800">UTG Messenger</h1>
        <p className="text-sm text-stone-500">{reg ? 'Create your student account' : 'Sign in to message other UTG students'}</p>
        {fields.map(([k, p]) => <input key={k} placeholder={p} onChange={set(k)} className={inp} required={k !== 'faculty' && k !== 'department'} />)}
        {reg && (
          <select onChange={set('campusId')} className={inp} defaultValue="">
            <option value="">Select campus</option>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <input type="password" placeholder="Password (min 8 characters)" onChange={set('password')} className={inp} required />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="w-full rounded-lg bg-emerald-700 text-white py-2 font-medium hover:bg-emerald-800">{reg ? 'Create account' : 'Sign in'}</button>
        <button type="button" onClick={() => { setReg(!reg); setErr(''); }} className="w-full text-sm text-emerald-700">
          {reg ? 'I already have an account' : 'Create a student account'}
        </button>
      </form>
    </div>
  );
}

type Peer = { pc: RTCPeerConnection; dc?: RTCDataChannel; q: Promise<void> };

function Chat({ auth, onLogout, onUpdate }: any) {
  const { token, user: me } = auth;
  const sock = useRef<Socket>();
  const peers = useRef<Record<string, Peer>>({});
  const iceConfig = useRef<RTCConfiguration>({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const iceReady = useRef<Promise<void>>(Promise.resolve());
  const cryptoKeys = useRef<Record<string, CryptoKey>>({});
  const privateKey = useRef<CryptoKey | null>(null);
  const identityPromise = useRef<Promise<CryptoKey> | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const sentRead = useRef<Record<string, number>>({});
  const lastTyping = useRef(0);
  const [convos, setConvos] = useState<any[]>([]);
  const [active, setActive] = useState<any>(null);
  const [msgs, setMsgs] = useState<Record<string, any[]>>({});
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [p2p, setP2p] = useState<Set<string>>(new Set());
  const [delivered, setDelivered] = useState<Set<string>>(new Set());
  const [readUp, setReadUp] = useState<Record<string, number>>({});
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [info, setInfo] = useState(true);
  const [stats, setStats] = useState<any>(null);
  const [page, setPage] = useState('chats');
  const [reply, setReply] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [profile, setProfile] = useState<any>(null);
  const [adminTab, setAdminTab] = useState('stats');
  const [adminOpen, setAdminOpen] = useState(false);
  const [encryptNewChats, setEncryptNewChats] = useState(true);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [modalError, setModalError] = useState('');
  const activeRef = useRef<any>(null); activeRef.current = active;
  const convosRef = useRef<any[]>([]); convosRef.current = convos;

  const loadConvos = async () => { const l = await api('/api/conversations', token); setConvos(l); return l; };
  const request = (path: string, method?: string, body?: any) => api(path, token, body, method);
  const conversationKey = async (conversation: any) => {
    if (cryptoKeys.current[conversation.id]) return cryptoKeys.current[conversation.id];
    if (!identityPromise.current) identityPromise.current = ensureIdentity(me.id, request);
    privateKey.current = await identityPromise.current;
    const key = await getConversationKey(conversation.id, conversation.createdBy, me.id, privateKey.current, request);
    cryptoKeys.current[conversation.id] = key;
    return key;
  };
  const decodeMessage = async (m: any) => {
    if (m.deletedAt) return { ...m, body: '', deletedAt: m.deletedAt };
    if (!m.body?.startsWith('enc1:')) return m;
    const conversation = convosRef.current.find((c) => c.id === m.conversationId) || activeRef.current;
    try {
      if (!conversation) throw new Error('conversation unavailable');
      const key = await conversationKey(conversation);
      return { ...m, body: await decryptText(key, m.body), encryptedBody: m.body };
    } catch (e) {
      console.error('Unable to decrypt message', e);
      return { ...m, body: 'Encrypted message (key unavailable)', encryptedBody: m.body };
    }
  };
  // Merge by message id: P2P and server copies of one message collapse into one. Order = server seq, then time.
  const upsert = (m: any) => setMsgs((s) => {
    const l = s[m.conversationId] || [];
    const i = l.findIndex((x) => x.id === m.id);
    const n = i >= 0 ? l.map((x, j) => (j === i ? { ...x, ...m, via: x.via || m.via } : x)) : [...l, m];
    n.sort((a, b) => (a.seq ?? 1e12) - (b.seq ?? 1e12) || +new Date(a.createdAt) - +new Date(b.createdAt));
    return { ...s, [m.conversationId]: n };
  });

  // ---- WebRTC: backend only relays SDP/ICE; chat data flows over the DataChannel ----
  const bind = (to: string, p: Peer, dc: RTCDataChannel) => {
    p.dc = dc;
    dc.onopen = () => setP2p((s) => new Set(s).add(to));
    dc.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        const c = convosRef.current.find((c) => c.id === m.conversationId && !c.isGroup && c.others[0]?.id === to);
        if (c && typeof m.id === 'string' && typeof m.body === 'string')
          void decodeMessage({ ...m, body: m.body.slice(0, 20000), senderId: to, createdAt: new Date().toISOString(), via: 'p2p' }).then(upsert);
      } catch {}
    };
  };
  const getPeer = (to: string): Peer => {
    if (peers.current[to]) return peers.current[to];
    const pc = new RTCPeerConnection(iceConfig.current);
    const p: Peer = { pc, q: Promise.resolve() };
    peers.current[to] = p;
    pc.onicecandidate = (e) => e.candidate && sock.current!.emit('rtc:signal', { to, data: { candidate: e.candidate } });
    pc.ondatachannel = (e) => bind(to, p, e.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { // graceful fallback: sends go via server
        pc.close(); delete peers.current[to];
        setP2p((s) => { const n = new Set(s); n.delete(to); return n; });
      }
    };
    return p;
  };
  const call = async (to: string) => {
    if (peers.current[to]) return;
    await iceReady.current;
    const p = getPeer(to);
    bind(to, p, p.pc.createDataChannel('chat'));
    await p.pc.setLocalDescription(await p.pc.createOffer());
    sock.current!.emit('rtc:signal', { to, data: { sdp: p.pc.localDescription } });
  };

  useEffect(() => {
    const s: Socket = io(API || undefined, { auth: { token }, transports: ['websocket'] });
    sock.current = s;
    s.on('presence:list', (ids: string[]) => setOnline(new Set(ids)));
    s.on('presence', ({ userId, online }: any) => setOnline((o) => { const n = new Set(o); online ? n.add(userId) : n.delete(userId); return n; }));
    s.on('message:new', (m: any, ack: any) => { ack?.(true); void decodeMessage({ ...m, via: 'server' }).then(upsert); loadConvos(); });
    s.on('message:updated', (m: any) => { void decodeMessage(m).then(upsert); });
    s.on('sync', (rows: any[], ack: any) => { ack?.(true); rows.forEach((m) => void decodeMessage({ ...m, via: 'server' }).then(upsert)); loadConvos(); });
    s.on('message:delivered', ({ id }: any) => setDelivered((d) => new Set(d).add(id)));
    s.on('message:read', ({ conversationId, upToSeq }: any) => setReadUp((r) => ({ ...r, [conversationId]: Math.max(r[conversationId] || 0, upToSeq) })));
    s.on('typing', ({ conversationId }: any) => {
      if (activeRef.current?.id === conversationId) { setTyping(true); setTimeout(() => setTyping(false), 2000); }
    });
    s.on('rtc:signal', ({ from, data }: any) => {
      const p = getPeer(from);
      p.q = p.q.then(async () => { // serialize so ICE never beats the SDP it belongs to
        if (data.sdp) {
          await p.pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            await p.pc.setLocalDescription(await p.pc.createAnswer());
            s.emit('rtc:signal', { to: from, data: { sdp: p.pc.localDescription } });
          }
        } else if (data.candidate) await p.pc.addIceCandidate(data.candidate);
      }).catch(() => {});
    });
    identityPromise.current = ensureIdentity(me.id, request).then((key) => { privateKey.current = key; return key; })
      .catch((e) => { console.error('Unable to register encryption key', e); throw e; });
    void identityPromise.current.catch(() => {});
    iceReady.current = api('/api/rtc/turn-credentials', token).then((turn) => {
      iceConfig.current = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: turn.urls, username: turn.username, credential: turn.credential },
        ],
      };
    }).catch((e) => { console.error('Unable to retrieve TURN credentials; using STUN only', e); });
    void loadConvos().catch((e) => console.error('Unable to load conversations', e));
    void api('/api/users/me', token).then((user) => {
      if (user.settings?.defaultEncrypted === false) setEncryptNewChats(false);
    }).catch((e) => console.error('Unable to load profile settings', e));
    return () => { s.close(); Object.values(peers.current).forEach((p) => p.pc.close()); peers.current = {}; };
  }, []);

  useEffect(() => {
    if (!active) return;
    const max = Math.max(0, ...(msgs[active.id] || []).filter((m) => m.senderId !== me.id && m.seq != null).map((m) => m.seq));
    if (max > (sentRead.current[active.id] || 0)) {
      sentRead.current[active.id] = max;
      sock.current?.emit('message:read', { conversationId: active.id, upToSeq: max });
      setConvos((cs) => cs.map((c) => (c.id === active.id ? { ...c, unread: 0 } : c)));
    }
  }, [msgs, active]);

  useEffect(() => {
    if (!search.trim()) return setFound([]);
    const t = setTimeout(() => api('/api/users?q=' + encodeURIComponent(search), token).then(setFound).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [search]);

  const open = async (c: any) => {
    setPage('chats'); setActive(c); setTyping(false);
    setReply(null); setEditing(null); setPendingFiles([]);
    if (c.encrypted) {
      try { await conversationKey(c); }
      catch (e: any) { setModalError(e.message); }
    }
    if (!msgs[c.id]) {
      const messages = await api(`/api/conversations/${c.id}/messages`, token);
      for (const message of messages) upsert(await decodeMessage({ ...message, via: 'server' }));
    } else {
      for (const message of msgs[c.id].filter((item) => item.encryptedBody))
        upsert(await decodeMessage({ ...message, body: message.encryptedBody }));
    }
    if (!c.isGroup) call(c.others[0].id).catch(() => {});
  };
  const startWith = async (body: any) => {
    try {
      const { id } = await api('/api/conversations', token, { encrypted: encryptNewChats, ...body });
      const l = await loadConvos(); setSearch(''); setFound([]);
      open(l.find((c: any) => c.id === id));
    } catch (e: any) { alert(e.message); }
  };
  const newGroup = () => {
    const title = prompt('Group name');
    const names = prompt('Usernames, comma separated')?.split(',').map((s) => s.trim()).filter(Boolean);
    if (title && names?.length) startWith({ title, usernames: names });
  };

  const send = async () => {
    if ((!text.trim() && !pendingFiles.length) || !active) return;
    try {
    if (editing) {
      const body = active.encrypted ? await encryptText(await conversationKey(active), text.trim()) : text.trim();
      const updated = await api(`/api/messages/${editing.id}`, token, { body }, 'PATCH');
      upsert(await decodeMessage(updated));
      setEditing(null); setText('');
      return;
    }
    const attachments = [];
    for (const file of pendingFiles) {
      const uploadFile = active.encrypted ? await encryptFile(await conversationKey(active), file) : file;
      const form = new FormData();
      form.append('encrypted', String(!!active.encrypted));
      form.append('file', uploadFile, active.encrypted ? 'encrypted.bin' : file.name);
      const uploaded = await apiForm(`/api/conversations/${active.id}/uploads`, token, form);
      attachments.push(uploaded);
    }
    const plainBody = text.trim() || 'Attachment';
    const body = active.encrypted ? await encryptText(await conversationKey(active), plainBody) : plainBody;
    const m = { id: crypto.randomUUID(), conversationId: active.id, body, replyTo: reply?.id, attachmentIds: attachments.map((file: any) => file.id) };
    setText(''); setReply(null); setPendingFiles([]);
    upsert({ ...m, body: plainBody, attachments, senderId: me.id, createdAt: new Date().toISOString(), via: 'server' });
    const peer = !active.isGroup && peers.current[active.others[0].id];
    if (peer?.dc?.readyState === 'open') peer.dc.send(JSON.stringify(m)); // direct copy; server still persists
    const emit = () => sock.current!.timeout(8000).emit('message:send', m, (err: any, r: any) => {
      if (err) return setTimeout(emit, 2000); // retry is safe: server dedupes by id
      if (r?.ok) void decodeMessage({ ...r.message, via: 'server' }).then(upsert);
    });
    emit();
    } catch (e: any) { setModalError(e.message); }
  };

  const title = (c: any) => c.title || c.others?.[0]?.fullName || 'Chat';
  const other = active && !active.isGroup ? active.others[0] : null;
  const list = active ? msgs[active.id] || [] : [];
  const tick = (m: any) =>
    m.seq == null ? '…' : (readUp[m.conversationId] || 0) >= m.seq ? 'Read' : delivered.has(m.id) ? 'Delivered' : 'Sent';
  const dot = (id: string) => <span className={`inline-block w-2 h-2 rounded-full ${online.has(id) ? 'bg-emerald-500' : 'bg-stone-300'}`} />;
  const showAdmin = async (tab = 'stats') => {
    setAdminTab(tab); setAdminOpen(true); setModalError('');
    try {
      if (tab === 'stats') setStats(await api('/api/admin/stats', token));
      if (tab === 'users') setAdminUsers(await api('/api/admin/users', token));
      if (tab === 'reports') setReports(await api('/api/admin/reports', token));
    } catch (e: any) { setModalError(e.message); }
  };
  const showNotifications = async () => {
    setPage('notifications');
    try { setNotifications(await api('/api/notifications', token)); }
    catch (e: any) { setModalError(e.message); }
  };
  const showProfile = async (targetPage: string) => {
    setPage(targetPage);
    try { setProfile(await api('/api/users/me', token)); }
    catch (e: any) { setModalError(e.message); }
  };
  const saveProfile = async (e: any) => {
    e.preventDefault();
    try {
      const updated = await api('/api/users/me', token, {
        fullName: profile.fullName, faculty: profile.faculty, department: profile.department,
        bio: profile.bio || '', campusId: profile.campusId ? Number(profile.campusId) : null,
        ...(page === 'settings' ? { settings: { ...profile.settings, defaultEncrypted: encryptNewChats } } : {}),
      }, 'PATCH');
      setProfile(updated);
      setAuthUser({ ...me, fullName: updated.fullName, avatarUrl: updated.avatarUrl });
    } catch (e: any) { setModalError(e.message); }
  };
  const setAuthUser = (user: any) => {
    const updated = { ...auth, user };
    sessionStorage.setItem('auth', JSON.stringify(updated));
    onUpdate(updated);
  };
  const report = async (target: any) => {
    if (!target) return;
    const reason = prompt('Why are you reporting this message or user?');
    if (!reason?.trim()) return;
    try {
      await api('/api/reports', token, {
        reason: reason.trim(),
        ...(target.id ? { messageId: target.id, targetUserId: target.senderId } : { targetUserId: target.userId }),
      });
      alert('Report submitted for moderator review.');
    } catch (e: any) { setModalError(e.message); }
  };
  const markRead = async (item: any) => {
    await api(`/api/notifications/${item.id}/read`, token, {}, 'PATCH');
    setNotifications((items) => items.map((n) => n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n));
  };
  const downloadAttachment = async (file: any, conversation: any) => {
    try {
      const response = await fetch(API + file.url, { headers: { authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('Unable to download attachment');
      let blob: Blob = await response.blob();
      if (file.encrypted) blob = await decryptFile(await conversationKey(conversation), blob);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = file.encrypted ? 'attachment' : file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) { setModalError(e.message); }
  };
  const moderate = async (item: any, status: string) => {
    const resolution = prompt('Moderator notes', status === 'dismissed' ? 'Report dismissed' : 'Reviewed');
    if (resolution === null) return;
    const banTarget = status === 'reviewed' && item.targetUsername
      ? confirm(`Also suspend @${item.targetUsername}?`) : false;
    try {
      await api(`/api/admin/reports/${item.id}`, token, { status, resolution, banTarget }, 'PATCH');
      setReports((items) => items.map((r) => r.id === item.id ? { ...r, status, resolution } : r));
    } catch (e: any) { setModalError(e.message); }
  };
  const changeAccount = async (user: any) => {
    const banned = !user.banned;
    const roleInput = prompt('Account role: student or admin', user.role);
    if (!roleInput || !['student', 'admin'].includes(roleInput)) return;
    const role = roleInput;
    if (!confirm(`${banned ? 'Suspend' : 'Restore'} @${user.username} and set role to ${role}?`)) return;
    try {
      const updated = await api(`/api/admin/users/${user.id}`, token, { banned, role }, 'PATCH');
      setAdminUsers((users) => users.map((u) => u.id === user.id ? updated : u));
    } catch (e: any) { setModalError(e.message); }
  };
  const resetPassword = async (user: any) => {
    const password = prompt(`Set a new password for @${user.username} (at least 8 characters)`);
    if (password === null) return;
    try {
      const updated = await api(`/api/admin/users/${user.id}`, token, {
        banned: user.banned, role: user.role, password,
      }, 'PATCH');
      setAdminUsers((users) => users.map((item) => item.id === user.id ? updated : item));
      alert('Password updated.');
    } catch (e: any) { setModalError(e.message); }
  };

  return (
    <div className="h-screen flex bg-stone-100 text-stone-800">
      <aside className={`${active && page === 'chats' ? 'hidden md:flex' : 'flex'} w-full md:w-80 flex-col bg-white border-r border-stone-200`}>
        <div className="p-4 flex items-center justify-between bg-emerald-800 text-white">
          <div className="flex items-center gap-2">
            {me.avatarUrl && <img src={API + me.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />}
            <div><p className="font-bold">UTG Messenger</p><p className="text-xs text-emerald-200">{me.fullName} (@{me.username})</p></div>
          </div>
          <div className="flex gap-3">
            <button title="Notifications" onClick={showNotifications}><Bell size={18} /></button>
            <button title="Profile" onClick={() => showProfile('profile')}><UserRound size={18} /></button>
            <button title="Settings" onClick={() => showProfile('settings')}><Settings size={18} /></button>
            {me.role === 'admin' && <button title="Admin" onClick={() => void showAdmin()}><Shield size={18} /></button>}
            <button title="Log out" onClick={onLogout}><LogOut size={18} /></button>
          </div>
        </div>
        <div className="flex gap-1 border-b border-stone-200 p-2 text-xs">
          <button onClick={() => setPage('chats')} className={`flex-1 rounded px-2 py-2 ${page === 'chats' ? 'bg-emerald-100 text-emerald-800' : ''}`}>Chats</button>
          <button onClick={() => setPage('discovery')} className={`flex-1 rounded px-2 py-2 ${page === 'discovery' ? 'bg-emerald-100 text-emerald-800' : ''}`}>Discover</button>
        </div>
        <div className="p-3 flex gap-2">
          <div className="relative flex-1"><Search size={14} className="absolute left-3 top-3 text-stone-400" />
            <input value={search} onChange={(e) => { setSearch(e.target.value); setPage('discovery'); }} placeholder="Find students" className={inp + ' pl-8'} /></div>
          <button title="New group" onClick={newGroup} className="rounded-lg border border-stone-300 px-3"><Users size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {found.map((u) => (
            <button key={u.id} onClick={() => startWith({ usernames: [u.username] })} className="w-full text-left px-4 py-3 hover:bg-emerald-50 border-b border-stone-100">
              {dot(u.id)} <span className="font-medium">{u.fullName}</span><p className="text-xs text-stone-500">@{u.username} · {u.campus || 'No campus'}</p>
            </button>
          ))}
          {!found.length && convos.map((c) => (
            <button key={c.id} onClick={() => open(c)} className={`w-full text-left px-4 py-3 border-b border-stone-100 hover:bg-emerald-50 ${active?.id === c.id ? 'bg-emerald-50' : ''}`}>
              <div className="flex justify-between"><span className="font-medium">{!c.isGroup && dot(c.others[0]?.id)} {title(c)}</span>
                {c.unread > 0 && <span className="text-xs bg-amber-500 text-white rounded-full px-2">{c.unread}</span>}</div>
              <p className="text-xs text-stone-500 truncate">{c.encrypted && c.last ? 'End-to-end encrypted message' : c.last?.body || 'No messages yet'}</p>
            </button>
          ))}
          {!found.length && !convos.length && <p className="p-4 text-sm text-stone-500">Search for a student above to start your first conversation.</p>}
        </div>
      </aside>

      <main className={`${active && page === 'chats' ? 'flex' : 'flex'} flex-1 flex-col min-w-0 overflow-y-auto`}>
        {page === 'discovery' ? <section className="m-auto w-full max-w-3xl p-6">
          <h1 className="mb-2 text-2xl font-semibold">Discover students</h1>
          <p className="mb-5 text-sm text-stone-500">Search by name or username in the left sidebar to find students.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {found.map((u) => <button key={u.id} onClick={() => startWith({ usernames: [u.username] })}
              className="flex items-center gap-3 rounded-xl bg-white p-4 text-left shadow-sm hover:bg-emerald-50">
              {u.avatarUrl ? <img src={API + u.avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" /> : <UserRound />}
              <span><b>{u.fullName}</b><span className="block text-xs text-stone-500">@{u.username} · {u.campus || 'No campus'} · {u.faculty || 'Student'}</span></span>
            </button>)}
            {!found.length && <p className="text-sm text-stone-500">Enter a name in the sidebar to see matching students.</p>}
          </div>
        </section> : page === 'notifications' ? <section className="mx-auto w-full max-w-3xl p-6">
          <div className="mb-5 flex items-center justify-between"><h1 className="text-2xl font-semibold">Notifications</h1>
            <button onClick={async () => { await api('/api/notifications/read-all', token, {}); setNotifications((items) => items.map((n) => ({ ...n, readAt: new Date().toISOString() }))); }}
              className="text-sm text-emerald-700">Mark all read</button></div>
          {notifications.map((item) => <button key={item.id} onClick={() => {
            void markRead(item);
            const conversation = convos.find((c) => c.id === item.payload.conversationId);
            if (conversation) { setPage('chats'); void open(conversation); }
          }} className={`mb-2 block w-full rounded-lg p-4 text-left ${item.readAt ? 'bg-white' : 'bg-emerald-50'}`}>
            <span className="font-medium">New message</span><span className="block text-xs text-stone-500">{new Date(item.createdAt).toLocaleString()}</span>
          </button>)}
          {!notifications.length && <p className="text-stone-500">You’re all caught up.</p>}
        </section> : page === 'profile' || page === 'settings' ? <section className="mx-auto w-full max-w-2xl p-6">
          <h1 className="mb-5 text-2xl font-semibold">{page === 'profile' ? 'My profile' : 'Settings'}</h1>
          {!profile ? <p>Loading…</p> : <form onSubmit={saveProfile} className="space-y-4 rounded-xl bg-white p-5">
            {page === 'profile' && <div className="flex items-center gap-4">
              {profile.avatarUrl ? <img src={API + profile.avatarUrl} alt="" className="h-20 w-20 rounded-full object-cover" /> : <UserRound size={36} />}
              <label className="cursor-pointer rounded border px-3 py-2 text-sm">Upload profile picture
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0]; if (!file) return;
                  try {
                    const form = new FormData(); form.append('file', file);
                    const result = await apiForm('/api/users/me/avatar', token, form);
                    setProfile({ ...profile, avatarUrl: result.avatarUrl });
                    setAuthUser({ ...me, avatarUrl: result.avatarUrl });
                  } catch (x: any) { setModalError(x.message); }
                }} />
              </label>
            </div>}
            <label className="block text-sm">Full name<input className={inp + ' mt-1'} value={profile.fullName || ''} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} /></label>
            {page === 'profile' ? <>
              <label className="block text-sm">Faculty<input className={inp + ' mt-1'} value={profile.faculty || ''} onChange={(e) => setProfile({ ...profile, faculty: e.target.value })} /></label>
              <label className="block text-sm">Department<input className={inp + ' mt-1'} value={profile.department || ''} onChange={(e) => setProfile({ ...profile, department: e.target.value })} /></label>
              <label className="block text-sm">About me<textarea maxLength={500} className={inp + ' mt-1'} value={profile.bio || ''} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} /></label>
            </> : <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={encryptNewChats} onChange={(e) => {
                setEncryptNewChats(e.target.checked);
                setProfile({ ...profile, settings: { ...profile.settings, defaultEncrypted: e.target.checked } });
              }} />
              Encrypt new conversations by default
            </label>}
            <button className="rounded-lg bg-emerald-700 px-4 py-2 text-white">Save changes</button>
          </form>}
        </section> : page === 'chats' && !active ? <div className="m-auto text-stone-400">Select a conversation</div> : page === 'chats' ? <>
          <header className="p-3 bg-white border-b border-stone-200 flex items-center gap-3">
            <button className="md:hidden text-emerald-700" onClick={() => setActive(null)}>Back</button>
            <div className="flex-1"><p className="font-semibold">{title(active)}</p>
              <p className="text-xs text-stone-500">{typing ? 'typing…' : other ? (online.has(other.id) ? 'Online' : 'Offline') : `${active.others.length + 1} members`}
                {active.encrypted && ' · End-to-end encrypted'}</p></div>
            {other && <span className={`text-xs flex items-center gap-1 ${p2p.has(other.id) ? 'text-emerald-700' : 'text-stone-400'}`}>
              <Wifi size={14} />{p2p.has(other.id) ? 'Direct (P2P)' : 'Via server'}</span>}
            <button className="hidden lg:block" onClick={() => setInfo(!info)}><PanelRight size={18} /></button>
            {other && <button title="Report user" onClick={() => void report({ userId: other.id })}><Flag size={16} /></button>}
          </header>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {list.map((m) => { const mine = m.senderId === me.id; return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : ''}`}>
                <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${mine ? 'bg-emerald-700 text-white' : 'bg-white border border-stone-200'}`}>
                  {active.isGroup && !mine && <p className="text-xs font-medium text-amber-700">{active.others.find((o: any) => o.id === m.senderId)?.fullName}</p>}
                  {m.replyTo && <p className={`mb-1 border-l-2 pl-2 text-xs ${mine ? 'border-emerald-300 text-emerald-100' : 'border-stone-300 text-stone-500'}`}>
                    Reply to: {list.find((item) => item.id === m.replyTo)?.body || 'Earlier message'}</p>}
                  {!m.deletedAt && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                  {m.deletedAt && <p className="italic opacity-70">This message was deleted</p>}
                  {!!m.attachments?.length && <div className="mt-2 space-y-1">
                    {m.attachments.map((file: any) => <button key={file.id} onClick={() => void downloadAttachment(file, active)}
                      className="flex items-center gap-2 rounded bg-black/10 px-2 py-1 text-left text-xs">
                      {file.mimeType?.startsWith('image/') ? <UserRound size={16} /> : <FileText size={16} />}
                      {file.encrypted ? 'Encrypted attachment' : file.name}
                    </button>)}
                  </div>}
                  <p className={`text-[10px] mt-1 ${mine ? 'text-emerald-200' : 'text-stone-400'}`}>
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {m.editedAt ? ' · edited' : ''}
                    {mine ? ' · ' + tick(m) : m.via === 'p2p' ? ' · direct' : ''}</p>
                  <div className="mt-1 flex gap-2 text-[10px] opacity-80">
                    {!m.deletedAt && <button title="Reply" onClick={() => { setReply(m); setEditing(null); }}><Reply size={13} /></button>}
                    {mine && !m.deletedAt && <button title="Edit" onClick={() => { setEditing(m); setReply(null); setText(m.body); }}><Pencil size={13} /></button>}
                    {mine && !m.deletedAt && <button title="Delete" onClick={async () => {
                      if (!confirm('Delete this message?')) return;
                      try { upsert(await api(`/api/messages/${m.id}`, token, undefined, 'DELETE')); }
                      catch (e: any) { setModalError(e.message); }
                    }}><Trash2 size={13} /></button>}
                    {!mine && <button title="Report message" onClick={() => void report(m)}><Flag size={13} /></button>}
                  </div>
                </div>
              </div>); })}
          </div>
          <div className="border-t border-stone-200 bg-white p-3">
            {(reply || editing) && <div className="mb-2 flex items-center justify-between rounded bg-emerald-50 px-3 py-2 text-xs">
              <span>{editing ? 'Editing message' : `Replying to ${reply.senderId === me.id ? 'yourself' : 'message'}`}</span>
              <button onClick={() => { setReply(null); setEditing(null); setText(''); }}>Cancel</button>
            </div>}
            {!!pendingFiles.length && <div className="mb-2 flex flex-wrap gap-2 text-xs">
              {pendingFiles.map((file, i) => <button key={i} onClick={() => setPendingFiles((files) => files.filter((_, n) => n !== i))}
                className="rounded bg-stone-100 px-2 py-1">{file.name} ×</button>)}
            </div>}
            <div className="flex gap-2">
            <input ref={uploadInput} type="file" multiple className="hidden" onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              setPendingFiles((files) => [...files, ...picked].slice(0, 5));
              e.target.value = '';
            }} />
            <button title="Attach files" onClick={() => uploadInput.current?.click()} className="rounded-lg border px-3"><Paperclip size={16} /></button>
            <input value={text} maxLength={4000} placeholder={editing ? 'Edit message' : 'Write a message'} className={inp}
              onChange={(e) => { setText(e.target.value); if (Date.now() - lastTyping.current > 2000) { lastTyping.current = Date.now(); sock.current?.emit('typing', active.id); } }}
              onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button onClick={send} className="rounded-lg bg-emerald-700 text-white px-4"><Send size={16} /></button>
            </div>
          </div>
        </> : <div className="m-auto text-stone-400">Choose a section from the sidebar</div>}
      </main>

      {active && page === 'chats' && info && (
        <aside className="hidden lg:block w-72 bg-white border-l border-stone-200 p-5 text-sm space-y-2">
          <p className="font-semibold text-base">{title(active)}</p>
          {other ? <>
            <p>@{other.username}</p><p>Campus: {other.campus || 'Not set'}</p><p>Faculty: {other.faculty || 'Not set'}</p>
            <p>Status: {online.has(other.id) ? 'Online' : 'Offline'}</p>
            <p>Transport: {p2p.has(other.id) ? 'WebRTC DataChannel' : 'Server relay (Socket.IO)'}</p>
          </> : <ul>{active.others.map((o: any) => <li key={o.id}>{dot(o.id)} {o.fullName}</li>)}</ul>}
        </aside>
      )}

      {adminOpen && <div className="fixed inset-0 z-20 grid place-items-center bg-black/40 p-4" onClick={() => setAdminOpen(false)}>
        <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-5 text-sm" onClick={(e) => e.stopPropagation()}>
          <div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-semibold">Administration</h2>
            <button onClick={() => setAdminOpen(false)}>Close</button></div>
          <nav className="mb-4 flex gap-2 border-b pb-2">
            {['stats', 'users', 'reports'].map((tab) => <button key={tab} onClick={() => void showAdmin(tab)}
              className={`rounded px-3 py-2 capitalize ${adminTab === tab ? 'bg-emerald-100' : ''}`}>{tab}</button>)}
          </nav>
          {adminTab === 'stats' && stats && <div className="space-y-1">
            <p>Registered students: {stats.users}</p><p>Online now: {stats.onlineUsers}</p>
            <p>Messages: {stats.messages.total} ({stats.messages.lastHour} in the last hour)</p>
            {stats.byCampus.map((c: any) => <p key={c.name}>{c.name}: {c.n} students</p>)}
          </div>}
          {adminTab === 'users' && <div className="divide-y">
            {adminUsers.map((user) => <div key={user.id} className="flex items-center justify-between gap-3 py-3">
              <div><b>{user.fullName}</b> @{user.username} <span className="text-stone-500">· {user.email} · {user.role}</span>
                {user.banned && <span className="ml-2 text-red-600">Suspended</span>}</div>
              <div className="flex gap-2">
                <button onClick={() => void changeAccount(user)} className="rounded border px-3 py-1">{user.banned ? 'Restore' : 'Manage'}</button>
                <button onClick={() => void resetPassword(user)} className="rounded border px-3 py-1">Reset password</button>
              </div>
            </div>)}
          </div>}
          {adminTab === 'reports' && <div className="divide-y">
            {reports.map((item) => <div key={item.id} className="py-3">
              <p><b>Report #{item.id}</b> · {item.status} · from @{item.reporterUsername} {item.targetUsername && `about @${item.targetUsername}`}</p>
              <p className="my-1">{item.reason}</p>
              {item.messageBody && <blockquote className="my-2 border-l-2 border-stone-300 pl-3 text-stone-600">{item.messageBody}</blockquote>}
              {item.status === 'open' && <div className="flex gap-2">
                <button onClick={() => void moderate(item, 'reviewed')} className="rounded bg-emerald-700 px-3 py-1 text-white">Review</button>
                <button onClick={() => void moderate(item, 'dismissed')} className="rounded border px-3 py-1">Dismiss</button>
              </div>}
            </div>)}
            {!reports.length && <p className="py-4 text-stone-500">No reports have been filed.</p>}
          </div>}
        </div>
      </div>}
      {modalError && <div className="fixed bottom-4 right-4 z-30 max-w-sm rounded-lg bg-red-700 p-3 text-white shadow-lg">
        <button className="float-right ml-3" onClick={() => setModalError('')}>×</button>{modalError}
      </div>}
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<any>(() => { try { return JSON.parse(sessionStorage.getItem('auth') || 'null'); } catch { return null; } });
  const set = (a: any) => { a ? sessionStorage.setItem('auth', JSON.stringify(a)) : sessionStorage.removeItem('auth'); setAuth(a); };
  return auth ? <Chat auth={auth} onLogout={() => set(null)} onUpdate={set} /> : <Auth onAuth={set} />;
}
