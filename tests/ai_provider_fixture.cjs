// Test-only provider fixture. Never loaded by the production start command.
const dns=require('node:dns').promises;
dns.lookup=async host=>host==='internal.test'?[{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}];
const original=global.fetch;
global.fetch=async(url,options={})=>{
 if(String(url)!=='https://ai.example.test/v1/chat/completions')return original(url,options);
 const b=JSON.parse(options.body),lastUser=[...b.messages].reverse().find(m=>m.role==='user')?.content||'',last=b.messages.at(-1);
 if(options.headers.Authorization!=='Bearer test-provider-secret-key')return new Response('{}',{status:401});
 if(lastUser.includes('超时'))throw Error('provider timeout');
 if(lastUser.includes('限流'))return new Response('{}',{status:429});
 if(lastUser.includes('认证失败'))return new Response('{}',{status:401});
 if(lastUser.includes('损坏响应'))return new Response('bad-json');
 if(lastUser.includes('等待'))await new Promise(r=>setTimeout(r,500));
 const answer=content=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content}}]}));
 const call=(name,args)=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call-'+b.messages.length,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}}]}}]}));
 if(!b.tools)return answer('连接成功');
 if(lastUser.includes('工具越权'))return last.role==='tool'?answer('不支持该工具，未修改账本。'):call('execute_sql',{sql:'DELETE FROM accounts'});
 if(lastUser.includes('无效参数'))return last.role==='tool'?answer('查询参数无效，未修改。'):call('accounts','{bad-json');
 const accountEdit=/修改账户分类/.test(lastUser),txEdit=/修改流水/.test(lastUser);
 const tools=b.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
 if(accountEdit||txEdit){
  if(!tools.length)return call(accountEdit?'accounts':'cashflow',accountEdit?{}:{from:'2026-01-01',to:'2026-12-31',currency:'CNY'});
  if(tools.length===1){const row=tools[0].rows.find(r=>accountEdit?r.name==='测试现金':r.merchant==='咖啡店');if(!row)return answer('未找到记录');return call(accountEdit?'propose_account_category':'propose_transaction_update',accountEdit?{id:row.id,category:'支付账户'}:{id:row.id,category:'餐饮',amount:35.5});}
  return answer('已生成修改草案，尚未写入账本，请先核对并确认。');
 }
 if(lastUser.includes('现金方案'))return !tools.length?call('reserve_scenarios',{monthlyExpense:30000,months:[3,6]}):answer('按用户提供的每月3万元，程序已计算现金储备方案。');
 if(lastUser.includes('持仓'))return !tools.length?call('investments',{}):answer('当前投资账本的持仓已查询。');
 if(lastUser.includes('预算'))return !tools.length?call('budgets',{}):answer('已查询本月预算。');
 if(lastUser.includes('趋势'))return !tools.length?call('asset_trend',{days:30}):answer('现有日终快照已查询，缺少的历史没有补造。');
 if(lastUser.includes('收支'))return !tools.length?call('cashflow',{from:'2026-01-01',to:'2026-12-31',currency:'CNY'}):answer('已按人民币分别统计收入与支出，跨币种没有合并。');
 if(!tools.length)return call('asset_summary',{});
 if(lastUser.includes('多轮')&&tools.length===1)return call('accounts',{});
 const summary=tools.find(t=>t.netWorth!==undefined);
 return answer('**资产体检**\n净资产 '+summary.netWorth+' CNY = 总资产 '+summary.assets+' − 全部负债 '+summary.liabilities+'。\n报价与数据以查询时点为准，建议先核对必要开支及风险偏好。');
};
