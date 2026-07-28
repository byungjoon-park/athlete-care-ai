
async function startAI(){
 const video=document.getElementById("video");
 const stream=await navigator.mediaDevices.getUserMedia({
  video:{facingMode:"environment"}
 });
 video.srcObject=stream;
 initPose(video);
}
