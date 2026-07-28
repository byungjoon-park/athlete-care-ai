
function calculateFatigue(d){
 let score=Math.round(
 d.heightLoss*.4+
 d.landingError*.3+
 d.asymmetry*.3
 );
 document.getElementById("fatigue").innerText=score+"/100";
}
