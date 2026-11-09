import browser from './browser.js';
import api from './api.js';

export default {
  id: 'jobright', name: 'Jobright',
  capabilities: { transports: ['browser', 'api'], authentication: 'browser', operations: ['listJobs', 'getJobDetails', 'markAsApplied', 'getApplicationStatus'] },
  transports: { browser, api },
};
