const TABS = [
  { key: 'tables', label: 'Tables' },
  { key: 'sql', label: 'SQL' },
  { key: 'schema', label: 'Schema' },
] as const

export function ResourceTabs({
  projectName,
  resourceName,
  active,
}: {
  projectName: string
  resourceName: string
  active: 'tables' | 'sql' | 'schema'
}) {
  const base = `/projects/${encodeURIComponent(projectName)}/resources/${encodeURIComponent(resourceName)}`
  return (
    <div className="tabs">
      {TABS.map((tab) => (
        <a key={tab.key} href={`#${base}/${tab.key}`} className={`tab${tab.key === active ? ' active' : ''}`}>
          {tab.label}
        </a>
      ))}
    </div>
  )
}
