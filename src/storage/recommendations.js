import { randomUUID } from 'node:crypto';
import { ProfileStore } from './profile-titles.js';
import { jobWhere } from './job-filters.js';
import { ServiceError, notFound } from '../service/errors.js';

const active = "('queued','running','stop_requested')";
const now = () => new Date().toISOString();
const counters = ['updated','unchanged','unmatched','skipped','failed'];
export class RecommendationStore extends ProfileStore {
  recommendationRow(userId, id) {
    const row = this.db.prepare('SELECT * FROM ai_recommendations WHERE id=? AND user_id=?').get(id,userId);
    if (!row) throw notFound();
    return row;
  }
  recommendation(userId,id) {
    const row = this.recommendationRow(userId,id);
    return { id:row.id,status:row.status,total:row.total,processed:row.processed,
      ...Object.fromEntries(counters.map(key=>[key,row[key]])),
      queuedAt:row.queued_at,startedAt:row.started_at,endedAt:row.ended_at,errorCode:row.error_code,
      issues:this.db.prepare('SELECT error_code AS code,count(*) AS count FROM ai_recommendation_jobs WHERE recommendation_id=? AND error_code IS NOT NULL GROUP BY error_code ORDER BY error_code').all(id) };
  }
  latestRecommendation(userId) {
    const row = this.db.prepare(`SELECT id FROM ai_recommendations WHERE user_id=? ORDER BY (status IN ${active}) DESC,queued_at DESC,rowid DESC LIMIT 1`).get(userId);
    return row ? this.recommendation(userId,row.id) : null;
  }
  enqueueRecommendation(userId, filters = {}) {
    return this.transaction(()=>{
      const existing = this.db.prepare(`SELECT id FROM ai_recommendations WHERE user_id=? AND status IN ${active}`).get(userId);
      if (existing) throw new ServiceError(409,'RECOMMENDATION_EXISTS','AI recommendations are already queued or active.',{recommendationId:existing.id});
      const {where,params} = jobWhere(userId,filters), id=randomUUID();
      this.db.prepare("INSERT INTO ai_recommendations(id,user_id,status,queued_at) VALUES(?,?,'queued',?)").run(id,userId,now());
      this.db.prepare(`INSERT INTO ai_recommendation_jobs(recommendation_id,job_id,expected_revision)
        SELECT ?,j.id,j.preferred_title_revision FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE ${where}`).run(id,...params);
      this.db.prepare('UPDATE ai_recommendations SET total=(SELECT count(*) FROM ai_recommendation_jobs WHERE recommendation_id=?) WHERE id=?').run(id,id);
      return this.recommendation(userId,id);
    });
  }
  claimRecommendation() {
    return this.transaction(()=>{
      if (this.db.prepare("SELECT count(*) AS n FROM ai_recommendations WHERE status IN ('running','stop_requested')").get().n >= 2) return null;
      const row = this.db.prepare("SELECT * FROM ai_recommendations WHERE status='queued' ORDER BY queued_at,rowid LIMIT 1").get();
      if (!row) return null;
      this.db.prepare("UPDATE ai_recommendations SET status='running',started_at=? WHERE id=?").run(now(),row.id);
      return {id:row.id,userId:row.user_id};
    });
  }
  recommendationProfiles(userId,id) {
    this.recommendationRow(userId,id);
    return this.db.prepare(`SELECT DISTINCT c.id,c.specialization_prompt,c.specialization_model_json
      FROM ai_recommendation_jobs item JOIN jobs j ON j.id=item.job_id AND j.user_id=?
      JOIN connections c ON c.id=j.connection_id AND c.user_id=j.user_id WHERE item.recommendation_id=?`).all(userId,id)
      .map(row=>({id:row.id,prompt:row.specialization_prompt,model:row.specialization_model_json ? JSON.parse(row.specialization_model_json) : null,
        titles:this.profileTitles(userId,row.id).filter(title=>!title.isArchived).map(({id,title})=>({id,title}))}));
  }
  nextRecommendationJob(userId,id) {
    return this.nextRecommendationBatch(userId,id,1)[0] ?? null;
  }
  nextRecommendationBatch(userId,id,limit=10) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid recommendation batch size.');
    return this.transaction(()=>{
      if (this.recommendationRow(userId,id).status !== 'running') return [];
      const first = this.db.prepare(`SELECT j.connection_id FROM ai_recommendation_jobs item
        JOIN jobs j ON j.id=item.job_id AND j.user_id=?
        WHERE item.recommendation_id=? AND item.status='pending' ORDER BY j.id LIMIT 1`).get(userId,id);
      if (!first) return [];
      const items = this.db.prepare(`SELECT j.id,j.connection_id,j.title,j.company,j.details_json,j.preferred_title_revision,item.expected_revision
        FROM ai_recommendation_jobs item JOIN jobs j ON j.id=item.job_id AND j.user_id=?
        WHERE item.recommendation_id=? AND item.status='pending' AND j.connection_id IS ? ORDER BY j.id LIMIT ?`).all(userId,id,first.connection_id,limit);
      const claim = this.db.prepare("UPDATE ai_recommendation_jobs SET status='working' WHERE recommendation_id=? AND job_id=?");
      for (const item of items) claim.run(id,item.id);
      return items.map(item=>({id:item.id,connectionId:item.connection_id,title:item.title,company:item.company,details:JSON.parse(item.details_json),
        expectedRevision:item.expected_revision,currentRevision:item.preferred_title_revision}));
    });
  }
  settleRecommendationItem(id,jobId,status,code=null) {
    if (!counters.includes(status)) throw new Error('Invalid recommendation item status.');
    const result = this.db.prepare("UPDATE ai_recommendation_jobs SET status=?,error_code=? WHERE recommendation_id=? AND job_id=? AND status='working'").run(status,code,id,jobId);
    if (result.changes) this.db.prepare(`UPDATE ai_recommendations SET processed=processed+1,${status}=${status}+1 WHERE id=?`).run(id);
  }
  recommendationBatchRevisions(userId,id,jobIds) {
    if (this.recommendationRow(userId,id).status !== 'running') return [];
    if (!Array.isArray(jobIds) || !jobIds.length || jobIds.length>10 || jobIds.some(value=>!Number.isSafeInteger(value)))
      throw new Error('Invalid recommendation batch IDs.');
    return this.db.prepare(`SELECT j.id,j.preferred_title_revision AS currentRevision,item.expected_revision AS expectedRevision
      FROM ai_recommendation_jobs item JOIN jobs j ON j.id=item.job_id AND j.user_id=?
      WHERE item.recommendation_id=? AND item.status='working' AND j.id IN (${jobIds.map(()=>'?').join(',')})`).all(userId,id,...jobIds);
  }
  finishRecommendationItem(userId,id,jobId,result) {
    return this.finishRecommendationBatch(userId,id,[{jobId,...result}]);
  }
  finishRecommendationBatch(userId,id,results) {
    return this.transaction(()=>{
      if (this.recommendationRow(userId,id).status !== 'running') return;
      if (!Array.isArray(results) || !results.length || results.length>10 || new Set(results.map(result=>result.jobId)).size!==results.length)
        throw new Error('Invalid recommendation batch results.');
      for (const result of results) {
        const jobId=result.jobId;
        const item=this.db.prepare('SELECT * FROM ai_recommendation_jobs WHERE recommendation_id=? AND job_id=?').get(id,jobId);
        if (!item) throw notFound();
        if (item.status !== 'working') continue;
        const job=this.db.prepare('SELECT connection_id,preferred_title_id,preferred_title_revision FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
        if (!job) throw notFound();
        if (result.status) { this.settleRecommendationItem(id,jobId,result.status,result.code); continue; }
        if (job.preferred_title_revision !== item.expected_revision) { this.settleRecommendationItem(id,jobId,'skipped','SELECTION_CHANGED'); continue; }
        if (result.specializationId === null) { this.settleRecommendationItem(id,jobId,'unmatched'); continue; }
        const title=this.db.prepare('SELECT id FROM profile_titles WHERE id=? AND user_id=? AND connection_id=? AND is_archived=0').get(result.specializationId,userId,job.connection_id);
        if (!title) { this.settleRecommendationItem(id,jobId,'skipped','TITLE_UNAVAILABLE'); continue; }
        if (job.preferred_title_id === title.id) { this.settleRecommendationItem(id,jobId,'unchanged'); continue; }
        this.db.prepare('UPDATE jobs SET preferred_title_id=?,preferred_title_revision=preferred_title_revision+1 WHERE id=? AND user_id=?').run(title.id,jobId,userId);
        this.settleRecommendationItem(id,jobId,'updated');
      }
    });
  }
  finishRecommendation(userId,id,status,code=null) {
    return this.transaction(()=>{
      const row=this.recommendationRow(userId,id);
      if (!['queued','running','stop_requested'].includes(row.status)) return;
      if (!['completed','stopped','failed','interrupted'].includes(status)) throw new Error('Invalid recommendation status.');
      if (row.status === 'stop_requested') status='stopped';
      // An unfinished call is never replayed after cancellation or interruption.
      const working=this.db.prepare("SELECT job_id FROM ai_recommendation_jobs WHERE recommendation_id=? AND status='working'").all(id);
      for(const item of working) this.settleRecommendationItem(id,item.job_id,status==='failed'?'failed':'skipped',status==='failed'?(code ?? 'RECOMMENDATION_ERROR'):status==='stopped'?'CANCELLED':'INTERRUPTED');
      this.db.prepare('UPDATE ai_recommendations SET status=?,ended_at=?,error_code=? WHERE id=?').run(status,now(),code,id);
    });
  }
  stopRecommendation(userId,id) {
    return this.transaction(()=>{
      const row=this.recommendationRow(userId,id);
      if (row.status==='queued') this.db.prepare("UPDATE ai_recommendations SET status='stopped',ended_at=? WHERE id=?").run(now(),id);
      else if(row.status==='running') this.db.prepare("UPDATE ai_recommendations SET status='stop_requested' WHERE id=?").run(id);
      return this.recommendation(userId,id);
    });
  }
  recoverRecommendations() {
    for(const row of this.db.prepare("SELECT id,user_id FROM ai_recommendations WHERE status IN ('running','stop_requested')").all())
      this.finishRecommendation(row.user_id,row.id,'interrupted','INTERRUPTED');
  }
}
export const recommendationRpcMethods=['recommendation','latestRecommendation','enqueueRecommendation','claimRecommendation',
  'recommendationProfiles','nextRecommendationJob','nextRecommendationBatch','recommendationBatchRevisions','finishRecommendationItem','finishRecommendationBatch','finishRecommendation','stopRecommendation','recoverRecommendations'];
