import * as s from './schemas.js';

export function registerRecommendationRoutes(app,coordinator) {
  const route=(method,path,schema,handler)=>app.route({method,url:'/api/v1/ai/recommendations'+path,config:{admin:true},schema:{...schema,security:[{session:[]}]},handler});
  route('POST','',{body:{type:'object',additionalProperties:false,required:['filters'],properties:{filters:{type:'object',additionalProperties:false,properties:s.jobFilters}}},response:s.response(202,s.recommendation)},async(request,reply)=>{
    const result=await app.db.call('enqueueRecommendation',request.user.id,request.body.filters);
    reply.code(202).send(result); coordinator.wake();
  });
  route('GET','/latest',{response:s.response(200,{anyOf:[s.recommendation,{type:'null'}]})},request=>app.db.call('latestRecommendation',request.user.id));
  route('GET','/:id',{params:s.idParams,response:s.response(200,s.recommendation)},request=>app.db.call('recommendation',request.user.id,request.params.id));
  route('POST','/:id/stop',{params:s.idParams,response:s.response(200,s.recommendation)},async request=>{
    const result=await app.db.call('stopRecommendation',request.user.id,request.params.id);
    coordinator.cancel(request.params.id); return result;
  });
}
