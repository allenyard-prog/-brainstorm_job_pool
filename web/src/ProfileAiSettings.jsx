import { useState } from 'react';
import { useAction, useResource } from './data.js';
import { ErrorNotice, Loading } from './components.jsx';

export default function ProfileAiSettings({profile}) {
  const models=useResource('ai/models'), action=useAction();
  const [prompt,setPrompt]=useState(profile.specializationPrompt ?? ''),
    [provider,setProvider]=useState(profile.specializationModel?.provider ?? ''),
    [model,setModel]=useState(profile.specializationModel?.id ?? ''),
    [error,setError]=useState(null),[saved,setSaved]=useState(false);
  const available=(models.data ?? []).filter(item=>item.enabled && item.models.some(model=>model.capabilities.json));
  const choices=available.find(item=>item.id===provider)?.models.filter(item=>item.capabilities.json) ?? [];
  const configured=choices.some(item=>item.id===model);
  async function save(event,clear=false) {
    event.preventDefault(); setError(null); setSaved(false);
    if(!clear && prompt.trim() && !configured) {setError(new Error('Choose an enabled provider and JSON-capable model.'));return;}
    try {
      const result=await action.mutateAsync({path:`/connections/${profile.id}`,method:'PATCH',body:{specializationPrompt:clear ? null : prompt.trim() || null,specializationModel:clear ? null : configured ? {provider,id:model} : null}});
      setPrompt(result.specializationPrompt ?? '');setProvider(result.specializationModel?.provider ?? '');setModel(result.specializationModel?.id ?? '');setSaved(true);
    } catch { /* Shown inline. */ }
  }
  return <section className="profile-ai-settings">
    <h3>AI specialization rules</h3>
    <p className="muted">AI uses this rule, this profile’s active titles, and relevant job details. A blank rule disables recommendations for this profile.</p>
    {models.isPending && <Loading text="Loading AI models…"/>}
    <ErrorNotice error={models.error}/>
    {!models.isPending && !models.error && !available.length && <p className="notice">No JSON-capable AI models are enabled. Configure server API keys and model allowlists, then restart the backend.</p>}
    <form className="form-stack" onSubmit={save}>
      <label>Specialization rule prompt
        <textarea value={prompt} onChange={event=>{setPrompt(event.target.value);setSaved(false);}} maxLength={8000} rows={6} placeholder="For example, choose SRE for reliability and incident response; Platform Engineer for internal developer platforms."/>
        <small className="muted">{prompt.length.toLocaleString()} / 8,000 characters</small>
      </label>
      <div className="ai-model-fields">
        <label>AI provider<select value={provider} onChange={event=>{setProvider(event.target.value);setModel('');setSaved(false);}} disabled={action.isPending || models.isPending}>
          <option value="">Select provider</option>
          {provider && !available.some(item=>item.id===provider) && <option value={provider}>{provider} (unavailable)</option>}
          {available.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>AI model<select value={model} onChange={event=>{setModel(event.target.value);setSaved(false);}} disabled={action.isPending || !provider || !choices.length}>
          <option value="">Select model</option>
          {model && !configured && <option value={model}>{model} (unavailable)</option>}
          {choices.map(item=><option key={item.id} value={item.id}>{item.id}</option>)}
        </select></label>
      </div>
      {model && !configured && !models.isPending && <p className="notice">The saved model is unavailable. Select an enabled model or clear the AI settings.</p>}
      {!profile.titles?.some(title=>!title.isArchived) && <p className="muted">Add an active specialization before running recommendations.</p>}
      <ErrorNotice error={error ?? action.error}/>
      {saved && <p role="status">AI settings saved.</p>}
      <div className="button-row">
        <button className="button primary" disabled={action.isPending}>Save AI settings</button>
        <button type="button" className="button subtle" disabled={action.isPending} onClick={event=>save(event,true)}>Clear AI settings</button>
      </div>
    </form>
  </section>;
}
