export const emptyDetails = () => ({
  description: { text: '', html: null }, locations: [], workArrangement: null, employmentType: null, seniority: null,
  compensation: {}, responsibilities: [], qualifications: { required: [], preferred: [] }, skills: [], benefits: [], education: [],
  experience: {}, sponsorship: {}, company: {}, applicationUrl: null, postedAt: null, matching: {}, extra: {},
});

export function normalizeApiJob(result, baseUrl = 'https://jobright.ai') {
  const job = result.jobResult;
  const company = result.companyResult ?? {};
  if (!job?.jobId || !job.jobTitle) throw new Error('Jobright job response is missing jobId or jobTitle.');
  const details = emptyDetails();
  details.description = { text: job.jobDescription ?? job.description ?? job.jobSummary ?? '', html: job.jobDescriptionHtml ?? null };
  details.locations = job.jobLocations ?? (job.jobLocation ? [job.jobLocation] : []);
  details.workArrangement = job.workModel ?? null;
  details.employmentType = job.employmentType ?? null;
  details.seniority = job.jobSeniority ?? null;
  details.compensation = { minimum: job.minSalary ?? null, maximum: job.maxSalary ?? null, display: job.salaryDesc ?? null, currency: job.salaryCurrency ?? null, period: job.salaryPeriod ?? null };
  details.responsibilities = job.coreResponsibilities ?? [];
  details.qualifications = { required: job.qualifications?.mustHave ?? job.skillSummaries ?? [], preferred: job.qualifications?.preferredHave ?? [] };
  details.skills = (job.jdCoreSkills ?? []).map(skill => typeof skill === 'string' ? skill : skill.skill);
  details.benefits = job.benefitsSummaries ?? [];
  details.education = job.educationSummaries ?? [];
  details.experience = { minimumYears: job.minYearsOfExperience ?? null, requirements: job.detailQualifications?.mustHave?.yoe ?? [] };
  details.sponsorship = { h1bSponsor: job.isH1bSponsor ?? null, citizenshipRequired: job.isCitizenOnly ?? null, clearanceRequired: job.isClearanceRequired ?? null, workAuthorizationRequired: job.isWorkAuthRequired ?? null };
  details.company = company;
  details.applicationUrl = job.applyLink || job.originalUrl || null;
  details.postedAt = job.publishTime ?? null;
  details.matching = { score: result.displayScore ?? null, label: result.rankDesc ?? null, recommendations: job.recommendationScores ?? [], skills: job.skillMatchingScores ?? [], industries: job.industryMatchingScores ?? [] };
  details.extra = { jobTags: job.jobTags ?? [], detailedQualifications: job.detailQualifications ?? {}, sourceDescription: job.jobSummary ?? null };
  return { id: String(job.jobId), url: `${baseUrl}/jobs/info/${job.jobId}`, title: job.jobTitle, company: company.companyName ?? null, details, raw: result };
}
