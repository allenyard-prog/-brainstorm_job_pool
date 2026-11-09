import { isDeepStrictEqual } from 'node:util';

export function compareJobs(browserJob, apiJob) {
  const differences = [];
  const check = (field, a, b) => { if (!isDeepStrictEqual(a, b)) differences.push(field); };
  check('id', browserJob.id, apiJob.id);
  check('title', browserJob.title, apiJob.title);
  check('company', browserJob.company, apiJob.company);
  for (const key of ['locations', 'workArrangement', 'employmentType', 'seniority', 'responsibilities', 'qualifications', 'benefits']) {
    check(key, browserJob.details[key], apiJob.details[key]);
  }
  const skills = job => job.details.skills.map(skill => (typeof skill === 'string' ? skill : skill.skill).toLowerCase()).sort();
  check('skills', skills(browserJob), skills(apiJob));
  return { matches: differences.length === 0, differences, jobId: browserJob.id };
}
