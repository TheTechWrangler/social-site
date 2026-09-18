import type { ReactNode, MouseEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';

export default function HomeNavigationLink({
  children,
  className,
  onRefresh,
}: {
  children: ReactNode;
  className?: string;
  onRefresh: () => void;
}) {
  const location = useLocation();

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (location.pathname !== '/') return;
    event.preventDefault();
    onRefresh();
  }

  return <Link to="/" className={className} onClick={handleClick}>{children}</Link>;
}
