import { useId } from 'react';

export default function ImageDescription({ value, onChange, disabled = false }: {
  value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const id = useId();
  return <div>
    <label htmlFor={id}>Image description</label>
    <textarea id={id} className="input" value={value} onChange={event => onChange(event.target.value)}
      maxLength={500} disabled={disabled} aria-describedby={`${id}-help`} rows={2} />
    <p id={`${id}-help`} className="muted">Describe the image for people who cannot see it (up to 500 characters). Leave empty only if the image is decorative or repeats nearby text.</p>
  </div>;
}
