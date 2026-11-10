// Test-only provider fixture. Never loaded by the production start command.
const dns=require('node:dns').promises;
dns.lookup=async host=>host==='internal.test'?[{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}];
const original=global.fetch;
global.fetch=async(url,options={})=>{
 if(!['https://ai.example.test/v1/chat/completions','https://api.deepseek.com/chat/completions'].includes(String(url)))return original(url,options);
 const b=JSON.parse(options.body),lastUser=[...b.messages].reverse().find(m=>m.role==='user')?.content||'',last=b.messages.at(-1);
 if(options.headers.Authorization!=='Bearer test-provider-secret-key')return new Response('{}',{status:401});
 if(lastUser.includes('超时'))throw Error('provider timeout');
 if(lastUser.includes('限流'))return new Response('{}',{status:429});
 if(lastUser.includes('认证失败'))return new Response('{}',{status:401});
 if(lastUser.includes('损坏响应'))return new Response('bad-json');
 if(lastUser.includes('等待'))await new Promise(r=>setTimeout(r,500));
 const answer=(content,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{role:'assistant',content,...(/deepseek/i.test(b.model)?{reasoning_content:'fixture-private-reasoning'}:{})}}]}));
 const call=(name,args)=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,...(/deepseek/i.test(b.model)?{reasoning_content:'fixture-private-reasoning'}:{}),tool_calls:[{id:'call-'+b.messages.length,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}}]}}]}));
 if(/deepseek/i.test(b.model)&&b.tools){if(!b.thinking||b.max_tokens<16000||b.messages.some(m=>m.role==='assistant'&&typeof m.reasoning_content!=='string'))return new Response('{}',{status:400});}
 if(lastUser.includes('上一段因输出上限中断'))return answer('接续内容：请先核对数据，再完成后续行动。',b.messages.some(m=>m.content?.includes('持续截断'))?'length':'stop');
 if(lastUser.includes('输出截断')||lastUser.includes('持续截断'))return answer('## 初步结论\n这一段尚未完整。','length');
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
 if(lastUser.includes('现金方案')&&!tools.some(t=>t.cash!==undefined))return call('reserve_scenarios',{monthlyExpense:30000,months:[3,6]});
 const diagnosis=tools.find(t=>t.domain&&Array.isArray(t.facts));
 const reportFor=d=>{
  const ids=new Set(d.facts.map(f=>f.id)),pick=(...values)=>values.filter(id=>ids.has(id));
  const portfolio=d.domain==='portfolio',cash=d.domain==='cashflow';
  const priorities=portfolio?[
   {title:'先核对集中在少数证券的风险',reason:'跨账户合并后的单只权重，才能说明组合是否集中，不能只看券商账户数。',action:'核对前几大持仓是否符合预期，并给单只证券设置你能接受的仓位上限。',caveat:'若主要持仓是宽基ETF，其权重不能直接等同单一公司经营风险。',evidenceIds:pick('top_security_weight','security_count')},
   {title:'先核实报价和汇率再判断盈亏',reason:'账面市值依赖报价日期和汇率，可估值部分不必然代表全部持仓。',action:'逐只核对报价日期，补齐缺失报价后再决定是否需要调整仓位。',caveat:'没有实时数据和财报，不能仅据账本断言个股高估或即将下跌。',evidenceIds:pick('securities_value')},
   {title:'用回撤情景决定风险承受边界',reason:'价格统一下降的账面影响可用于检查心理及资金承受能力，而非预测行情。',action:'将压力情景损失与你可接受的最大亏损比较，超出承受范围再考虑分步调整。',caveat:'压力情景彼此独立，没有包含个股相关性或实际成交费用。',evidenceIds:pick('securities_shock_20','foreign_securities')}
  ]:cash?[
   {title:'先区分未录入与真实零收入',reason:'记录月份覆盖不足时，不能把没有收入流水理解为家庭没有收入。',action:'核对工资及固定扣费是否完整录入，再评估持续结余能力。',caveat:'本月未结束，不能直接与完整月份做同口径比较。',evidenceIds:pick('recorded_completed_months','current_income')},
   {title:'用支出结构找可调整的部分',reason:'实际录入支出是改善消费结构的起点，不能把必要与可选支出混为一谈。',action:'核对大额分类中的必要与可选支出，优先逐项检查可选消费。',caveat:'未录入项目会造成低估，预算也不自动等于必要开支。',evidenceIds:pick('current_expense')},
   {title:'结余结论需要连续记录支持',reason:'单月结余和少量已录入月份不能证明长期现金流稳定。',action:'持续完整记录工资、家庭支出及利息，再比较连续完整月份。',caveat:'收入与支出按币种分别列示，不能把不同币种原币相加。',evidenceIds:pick('current_balance','observed_average_expense')}
  ]:[
   {title:'先看可用现金再看净资产规模',reason:'账面净资产不等于可支取资金，现金和流动负债需要按到期时间匹配。',action:'按实际到期日列出流动负债，并核对偿债后需要保留的家庭必要现金。',caveat:'流动负债不代表全部立即到期，投资账户现金是否可提仍需核对。',evidenceIds:pick('net_worth','known_cash','current_debt')},
   {title:'区分房产集中与证券波动影响',reason:'房产估值与证券价格对净资产影响的路径不同，需要分别做压力检查。',action:'明确房产的居住用途与长期目标，再评估能调整的金融资产比例。',caveat:'房产压力是假设情景，不构成房价预测或直接卖房建议。',evidenceIds:pick('property_weight','property_shock_10')},
   {title:'收入支出覆盖不足要先补齐',reason:'仅有资产余额不能推断家庭安全垫，持续开支和收入才决定现金需求。',action:'核对工资与固定扣费是否已录入，并确认每月含月供的必要支出。',caveat:'记录月份不完整时不强行计算长期结余或最优提前还贷金额。',evidenceIds:pick('current_expense','recorded_completed_months')}
  ];
  if(!d.hasData)return {conclusion:'目前账本缺少可分析的数据，应该先补齐记录，再对真实风险与调整方案做判断。',priorities:[{title:'先补齐本轮所需的账本记录',reason:'没有持仓或流水记录时，无法估算个人的实际仓位风险与现金需求。',action:'补录对应持仓数量、成本、报价或收入支出，再重新发起分析。',caveat:'当前不能把缺少数据解释为零风险，也不应给出具体买卖建议。',evidenceIds:[d.facts[0].id]}],comparisons:[],questions:['是否可以先补齐本次分析涉及的账本记录？']};
  return {conclusion:portfolio?'需要先判断持仓集中与可承受回撤，再决定是否调整；不同市场账户不自动等同风险分散。':cash?'先核对记录覆盖与必要支出，再判断消费调整和现金流是否可持续。':'净资产规模本身不足以说明资金安全，应先核对现金与到期负债，再比较资产压力及现金安排。',priorities,comparisons:portfolio?[
   {name:'保留现有持仓并设置观察边界',assumption:'证券价格统一下降10%，其余因素不变。',tradeoff:'没有新增交易成本，但仍需确认该损失是否能由家庭承受。',evidenceIds:pick('securities_shock_10')},
   {name:'按更大回撤检查是否应分步降集中',assumption:'证券价格统一下降20%，其余因素不变。',tradeoff:'若损失超出承受能力才讨论分步调整，未提供目标比例时不臆造买卖股数。',evidenceIds:pick('securities_shock_20','top_security_weight')}
  ]:cash?[
   {name:'先补齐固定收入和开支记录',assumption:'以现有记录覆盖为基础，不把缺失月份当零。',tradeoff:'结论更可靠，但需要完成补录后才能评估稳定结余。',evidenceIds:pick('recorded_completed_months')},
   {name:'先逐项检查可选消费',assumption:'只以本月已录入的支出作为核对起点。',tradeoff:'可以立即检查异常支出，但不能据此保证长期可节省金额。',evidenceIds:pick('current_expense')}
  ]:[
   {name:'先覆盖流动负债',assumption:'假设先偿还全部流动负债，不认为其当下全部到期。',tradeoff:'降低负债余额，但需核对剩余现金是否满足家庭必要开支。',evidenceIds:pick('cash_after_current_debt','current_debt')},
   {name:'先检查房产估值压力',assumption:'房产账面估值下降10%，负债保持不变。',tradeoff:'影响主要体现于净资产，而不是可支取现金；不能用房价预测替代流动性计划。',evidenceIds:pick('property_shock_10','property_shock_net_pct')}
  ],questions:portfolio?['你能承受的组合最大回撤是多少？','这笔投资资金预计什么时候需要使用？']:['家庭每月必要开支（含月供）是多少？','各笔贷款的利率与到期安排是什么？']};
 };
 if(diagnosis&&b.tools.some(t=>t.function.name==='submit_analysis')){
  if(lastUser.includes('错用资产')&&!tools.some(t=>t.error))return call('asset_summary',{});
  if(lastUser.includes('多轮')&&tools.length===1)return call('accounts',{});
  const report=reportFor(diagnosis);
  if(lastUser.includes('错误依据')&&!tools.some(t=>t.accepted===false))report.priorities[0].evidenceIds=['fabricated-fact'];
  if(lastUser.includes('一直无效'))report.priorities[0].evidenceIds=['fabricated-fact'];
  return call('submit_analysis',report);
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
