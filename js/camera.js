// Camera module
export async function startCamera(video){
  const stream = await navigator.mediaDevices.getUserMedia({video:true});
  video.srcObject = stream;
  return stream;
}
