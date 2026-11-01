export const SELL_SLIPPAGE_BPS=1000;
// These are explicit backend simulation rejections, not transport failures.
export function simulationRejected(error) {
  if(error?.details?.submissionEvidence===true)return false;
  return error?.code==='SIMULATION_FAILED'||error?.code==='AGENT_DEV_MODE_SIMULATION_FAILED'||
    error?.code==='BINANCE_API_ERROR'&&['953401','351805'].includes(String(error.details?.apiCode));
}
export function allowanceNeedsReview(change) {
  // Missing/malformed data is not evidence of a reduction. Amounts from the API
  // may be floating-point JSON numbers; only a strict reduction is auto-cleared.
  const amount=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?BigInt(v):
    typeof v==='string'&&/^\d+$/.test(v)?BigInt(v):null;
  const before=amount(change.preAmount),after=amount(change.postAmount);
  if(after===0n&&typeof change.preAmount==='number'&&Number.isFinite(change.preAmount)&&change.preAmount>0)return false;
  return before===null||after===null||after>before;
}
