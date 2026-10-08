import { LANGUAGES, isLangCode, type LangCode } from '../state/schema'

interface Props {
  id: string
  value: LangCode
  /** Most recent first. Shown above the full list. */
  recent: readonly LangCode[]
  onChange: (code: LangCode) => void
}

/** A language picker with the recently chosen languages on top. */
export function LanguageSelect({ id, value, recent, onChange }: Props) {
  const rest = LANGUAGES.filter((l) => !recent.includes(l.code))
  const nameOf = (code: LangCode) => LANGUAGES.find((l) => l.code === code)?.name ?? code
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => {
        const code = e.currentTarget.value
        if (isLangCode(code)) onChange(code)
      }}
    >
      {recent.length > 0 && (
        <optgroup label="Recent">
          {recent.map((code) => (
            <option value={code} key={code}>
              {nameOf(code)}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={recent.length > 0 ? 'All languages' : 'Languages'}>
        {rest.map((l) => (
          <option value={l.code} key={l.code}>
            {l.name}
          </option>
        ))}
      </optgroup>
    </select>
  )
}
