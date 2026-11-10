export function profileLabel(profile, fallback = "Imported account") {
  if (!profile) return fallback;
  return profile.personName
    ? `${profile.personName} · ${profile.label}`
    : profile.label;
}
