// JMP based fatigue score
export function fatigueScore(jmp){
  const score =
    (jmp.heightLoss || 0) * 0.4 +
    (jmp.flightLoss || 0) * 0.2 +
    (jmp.landingError || 0) * 0.2 +
    (jmp.asymmetry || 0) * 0.2;
  return Math.round(score);
}
