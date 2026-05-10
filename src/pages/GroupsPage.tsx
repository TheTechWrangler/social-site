import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export default function GroupsPage({ user }: { user: any }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadGroups(); }, []);

  async function loadGroups() {
    try { const r = await api.getGroups(); setGroups(r.groups); } catch (e) { console.error(e); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try { await api.createGroup(name.trim(), desc.trim()); setName(''); setDesc(''); await loadGroups(); } catch (e) { console.error(e); }
    setCreating(false);
  }

  return (
    <div className="groups-page">
      <h2>Groups</h2>
      <form className="post-composer" onSubmit={handleCreate}>
        <input className="input" placeholder="Group name" value={name} onChange={e => setName(e.target.value)} />
        <input className="input" placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} />
        <button className="btn btn-primary" disabled={creating || !name.trim()}>Create Group</button>
      </form>

      <div className="groups-list">
        {groups.map(g => (
          <Link to={`/groups/${g.id}`} key={g.id} className="group-card">
            <h4>{g.name}</h4>
            <p className="muted">{g.description || 'No description'}</p>
            <span className="muted">{g.member_count} members · by @{g.owner_username}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
