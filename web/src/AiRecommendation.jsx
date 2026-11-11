import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth.jsx';
import { useAction, useResource, invalidateJobs } from './data.js';
import { api } from './api.js';
import { ErrorNotice, Icon, Status } from './components.jsx';

const active=status=>['queued','running','stop_requested'].includes(status);
const explanations={NO_PROMPT:'Profile has no rule prompt',NO_MODEL:'Profile has no AI model',NO_ACTIVE_TITLES:'Profile has no active specializations',TOO_MANY_TITLES:'Profile exceeds the 99-title JSON schema limit',NO_PROFILE:'Job has no profile',SELECTION_CHANGED:'Selection changed manually after this operation started',TITLE_UNAVAILABLE:'Specialization was archived or is unavailable',INPUT_TOO_LARGE:'Job context exceeds the AI request limit',CANCELLED:'Generation cancelled',INTERRUPTED:'Generation interrupted',AI_PROVIDER_UNAVAILABLE:'Provider API key is missing',AI_MODEL_NOT_CONFIGURED:'Model is no longer configured',AI_UNSUPPORTED_CAPABILITY:'Model does not support JSON output',AI_PROVIDER_AUTH:'Provider rejected its server credentials',AI_RATE_LIMIT:'Provider rate limit reached',AI_INVALID_OUTPUT:'AI returned an invalid specialization',AI_TIMEOUT:'Generation timed out',AI_INVALID_RESPONSE:'Provider returned an unsupported response',AI_PROVIDER_ERROR:'Provider could not complete generation',AI_NETWORK_ERROR:'Provider could not be reached',AI_REFUSED:'Provider declined classification',AI_INCOMPLETE:'Provider returned incomplete output',RECOMMENDATION_ERROR:'Recommendation processing could not finish'};
export default function AiRecommendation({filters,disabled}) {
  const {user}=useAuth(),cache=useQueryClient(),action=useAction();
  const [error,setError]=useState(null),previous=useRef('');
  const key=['user',user.id,'ai/recommendations/latest',{}];
  const query=useResource('ai/recommendations/latest',{}, {interval:state=>active(state.state.data?.status)?2000:false});
  const operation=query.data,signature=operation ? `${operation.id}:${operation.processed}:${operation.status}` : '';
  useEffect(()=>{
    if(signature && previous.current!==signature) {previous.current=signature;void invalidateJobs(cache,user.id);}
  },[signature,cache,user.id]);
  async function start() {
    setError(null);
    try {
      const result=await action.mutateAsync({path:'/ai/recommendations',body:{filters}});
      cache.setQueryData(key,result);
    } catch(failure) {
      if(failure.code==='RECOMMENDATION_EXISTS' && failure.details?.recommendationId) {
        try {cache.setQueryData(key,await api(`/ai/recommendations/${encodeURIComponent(failure.details.recommendationId)}`));}
        catch(error) {setError(error);}
      } else setError(failure);
    }
  }
  async function stop() {
    setError(null);
    try {cache.setQueryData(key,await action.mutateAsync({path:`/ai/recommendations/${operation.id}/stop`}));}
    catch(error){setError(error);}
  }
  const percent=operation?.total ? Math.round(operation.processed/operation.total*100) : operation?.status==='completed'?100:0;
  return <section className="panel ai-recommendation" aria-label="AI specialization recommendations">
    <div className="ai-recommendation-heading">
      <div><h2>Specialization recommendations</h2><p className="muted">Uses each profile’s saved rule and model across all filtered pages, with up to 10 jobs per AI request. A match replaces the current Preferred title; no match keeps it.</p></div>
      <button className="button primary" onClick={start} disabled={disabled || action.isPending || active(operation?.status) || query.isPending}><Icon name="refresh" size={16}/>AI Recommendation</button>
    </div>
    <ErrorNotice error={error ?? query.error}/>
    {operation && <div className="ai-recommendation-progress" role="status" aria-live="polite">
      <div className="ai-recommendation-heading"><strong>AI recommendations: {operation.status.replaceAll('_',' ')}</strong><Status value={operation.status}/>
        {active(operation.status) && <button className="button subtle small" disabled={action.isPending || operation.status==='stop_requested'} onClick={stop}>Stop recommendations</button>}
      </div>
      <progress aria-label="AI recommendation progress" value={percent} max={100}/>
      <p>{operation.processed.toLocaleString()} / {operation.total.toLocaleString()} processed ({percent}%)</p>
      <p className="muted">{operation.updated} updated · {operation.unchanged} unchanged · {operation.unmatched} no match · {operation.skipped} skipped · {operation.failed} failed</p>
      {operation.errorCode && <p className="notice">{explanations[operation.errorCode] ?? operation.errorCode}. Saved selections have been preserved.</p>}
      {!!operation.issues?.length && <details><summary>Processing issues</summary><ul>{operation.issues.map(issue=><li key={issue.code}>{explanations[issue.code] ?? issue.code}: {issue.count}</li>)}</ul></details>}
    </div>}
  </section>;
}
