// The two documented usage endpoints return account metadata, never post/user reads.
function safeCode(error) {
  return /^(http-\d{3}|transport-failed|invalid-json|invalid-credit-balance|invalid-usage-response)$/.test(error?.code ?? '')
    ? error.code : 'check-failed';
}

export async function checkXAccess({client,budget,clock=()=>Date.now()}) {
  const readStartedAt=new Date(clock()).toISOString();
  let credit,usage;
  try {
    const balance=await client.creditBalance();
    budget.recordBalance({...balance,readStartedAt});
    credit={state:'verified',prepaidUsd:balance.prepaidUsd};
  } catch(error) {
    const code=safeCode(error);
    credit={state:'unavailable',code,action:code==='http-404'
      ? 'Check Billing in the X Developer Console. The documented balance endpoint is unavailable; a successful usage check does not verify dollars.'
      : 'Check the project billing and access settings in the X Developer Console.'};
  }
  try {await client.usageAccess();usage={state:'available'};}
  catch(error) {usage={state:'unavailable',code:safeCode(error)};}
  return {schemaVersion:1,checkedAt:new Date(clock()).toISOString(),credit,usage,
    paidReads:0,collectionStarted:false,credentialsChanged:false,
    note:'No post or account profiles were requested. Usage access and prepaid credit are separate checks.'};
}
