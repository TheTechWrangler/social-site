import { Link } from 'react-router-dom';

export default function LandingPage() {
  return (
    <div className="hero-landing">
      <p className="hero-brand-refuge"><span className="hero-brand-line">Refuge Gaming</span></p>
      <p className="hero-brand-amp">&amp;</p>
      <p className="hero-brand-caf">Cloud Access Foundation</p>
      <p className="hero-present-line">are proud to present</p>
      <h1 className="hero-title">Refuge Cloud</h1>
      <p className="hero-subtitle">
        A community-powered social platform for gamers, creators, builders, and open-tech communities —
        no ads, no algorithmic manipulation, just the feeds and conversations you choose.
      </p>
      <div className="hero-cta">
        <Link to="/register" className="btn-gold">Join the Community</Link>
        <Link to="/world" className="btn-outline">Explore World Feed</Link>
      </div>
      <p className="hero-trust">
        No ads · Chronological feeds · User-controlled sources · Community first
      </p>
    </div>
  );
}
