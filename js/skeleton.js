
function initPose(video){
 const pose=new Pose({
 locateFile:file=>"https://cdn.jsdelivr.net/npm/@mediapipe/pose/"+file
 });
 pose.setOptions({
 modelComplexity:1,
 smoothLandmarks:true,
 minDetectionConfidence:.5,
 minTrackingConfidence:.5
 });
 pose.onResults(result=>{
   if(result.poseLandmarks){
    calculateROM(result.poseLandmarks);
    calculateJMP(result.poseLandmarks);
   }
 });
 const cam=new Camera(video,{
  onFrame:async()=>{await pose.send({image:video})},
  width:640,height:480
 });
 cam.start();
}
