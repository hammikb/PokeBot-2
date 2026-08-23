'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, Boxes, ClipboardCheck, History, LayoutDashboard, ScrollText, ServerCog } from 'lucide-react'

const sections = [
  {
    label: 'Monitor',
    links: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/products', label: 'Products', icon: Boxes },
      { href: '/review', label: 'Link review', icon: ClipboardCheck },
      { href: '/history', label: 'Drop history', icon: History }
    ]
  },
  {
    label: 'Operations',
    links: [
      { href: '/infrastructure', label: 'Infrastructure', icon: ServerCog },
      { href: '/logs', label: 'Logs', icon: ScrollText }
    ]
  },
  {
    label: 'Analytics',
    links: [{ href: '/checkout-analytics', label: 'Checkout lab', icon: Activity }]
  }
]

export function NavBar() {
  const pathname = usePathname()

  return (
    <aside className="app-sidebar">
      <nav className="nav-bar" aria-label="Primary navigation">
        <div className="nav-inner">
          <Link className="nav-logo" href="/" aria-label="PokeAlert overview">
            <span className="nav-logo-mark" aria-hidden="true"><span /></span>
            <span className="nav-logo-copy"><strong>PokeAlert</strong><small>Restock console</small></span>
          </Link>
          {sections.map((section) => (
            <div className="nav-section" key={section.label}>
              <div className="nav-section-label">{section.label}</div>
              <div className="nav-links">
                {section.links.map(({ href, label, icon: Icon }) => {
                  const active = href === '/' ? pathname === href : pathname.startsWith(href)
                  return (
                    <Link className={`nav-link ${active ? 'active' : ''}`} href={href} key={href} aria-label={label} aria-current={active ? 'page' : undefined}>
                      <Icon size={17} aria-hidden="true" />
                      <span>{label}</span>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
          <div className="nav-status">
            <span className="status-dot" />
            <div><strong>Operations console</strong><span>Walmart + Target</span></div>
          </div>
        </div>
      </nav>
    </aside>
  )
}
