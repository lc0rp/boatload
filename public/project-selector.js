export function parseProjectCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const commaIndex = raw.lastIndexOf(",");
  const hasStub = commaIndex > 0 && commaIndex < raw.length - 1;
  const name = hasStub ? raw.slice(0, commaIndex).trim() : raw;
  const stub = hasStub ? normalizeProjectStub(raw.slice(commaIndex + 1)) : guessProjectStub(name);
  if (!name || !stub) return null;
  return { name, stub };
}

export function projectCreateLabel(candidate) {
  return candidate ? `Create "${candidate.name}, ${candidate.stub}"` : "";
}

export function projectDisplayName(project) {
  return project ? `${project.slug} · ${project.name}` : "";
}

export function findProject(projects, value) {
  const query = String(value || "").trim().toLowerCase();
  if (!query) return null;
  return projects.find((project) => {
    const slug = String(project.slug || "").toLowerCase();
    const name = String(project.name || "").toLowerCase();
    return slug === query || name === query || projectDisplayName(project).toLowerCase() === query;
  }) || null;
}

export function normalizeProjectStub(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function guessProjectStub(name) {
  const letters = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (letters || "PRJ").slice(0, 3);
}
