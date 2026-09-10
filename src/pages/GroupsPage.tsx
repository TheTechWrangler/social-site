import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';

export default function GroupsPage({ user }: { user: any }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGate = useRef(new RouteRequestGate());
  const currentAccountId = useRef(user?.id);
  currentAccountId.current = user?.id;

  const isVerified = user?.is_verified === 1 || user?.isVerified === true;

  useEffect(() => {
    setGroups([]);
    setSearch('');
    void loadGroups('');
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchGate.current.invalidate();
    };
  }, [user?.id]);

  function handleSearchChange(q: string) {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadGroups(q), 300);
  }

  async function loadGroups(q = '') {
    const requestedAccountId = user?.id;
    const isCurrent = searchGate.current.begin();
    try {
      const response = await api.getGroups(q || undefined);
      if (isCurrent() && currentAccountId.current === requestedAccountId) setGroups(response.groups);
    } catch (e) {
      if (isCurrent() && currentAccountId.current === requestedAccountId) console.error(e);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      await api.createGroup(name.trim(), desc.trim());
      setName(''); setDesc(''); setShowCreate(false);
      await loadGroups(search);
    } catch (e: any) { setCreateError(e.message || 'Could not create group.'); }
    setCreating(false);
  }

  return (
    <div className="groups-page">
      <div className="groups-page-header">
        <h2>Groups</h2>
        {isVerified && (
          <button className="btn btn-primary btn-sm" onClick={() => { setShowCreate(!showCreate); setCreateError(''); }}>
            {showCreate ? 'Cancel' : '+ New Group'}
          </button>
        )}
      </div>

      {showCreate && (
        <form className="post-composer groups-create-form" onSubmit={handleCreate}>
          <p className="muted" style={{ fontSize: '0.82rem', margin: 0 }}>
            Public group — RefugeCloud groups and posts published in them are public. Private groups are not available.
          </p>
          <input className="input" placeholder="Group name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} />
          <textarea className="input" placeholder="What is this group about? (optional)" value={desc} onChange={e => setDesc(e.target.value)} rows={2} maxLength={400} />
          {createError && <p className="error-msg">{createError}</p>}
          <button className="btn btn-primary" disabled={creating || !name.trim()}>{creating ? 'Creating…' : 'Create Group'}</button>
        </form>
      )}

      <input
        className="input groups-search"
        placeholder="Search groups…"
        value={search}
        onChange={e => handleSearchChange(e.target.value)}
      />

      {groups.length === 0 ? (
        <p className="muted groups-empty">{search ? `No groups matching "${search}".` : 'No groups yet. Be the first to create one!'}</p>
      ) : (
        <div className="groups-list">
          {groups.map(g => (
            <Link to={`/groups/${g.id}`} key={g.id} className="group-card">
              <div className="group-card-top">
                <h4 className="group-card-name">{g.name}</h4>
                {g.is_member ? <span className="group-member-badge">Joined</span> : null}
              </div>
              {g.description && <p className="group-card-desc">{g.description}</p>}
              <div className="group-card-meta">
                <span>{g.member_count} {g.member_count === 1 ? 'member' : 'members'}</span>
                <span className="group-card-owner">by @{g.owner_username}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
