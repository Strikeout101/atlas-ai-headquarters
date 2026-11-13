from PIL import Image; import numpy as np, sys
src=sys.argv[1]
a=np.array(Image.open(src)).astype(int)
r,g,b,al=a[...,0],a[...,1],a[...,2],a[...,3]
red=(r>110)&(r>g*1.7)&(r>b*1.7)
al=np.where(red&(al<235),0,al)
al=np.where(al<48,0,al)
al=np.where(al>=235,255,al)
# remove tiny isolated specks: connected components small
from scipy import ndimage
lab,n=ndimage.label(al>0)
sizes=ndimage.sum(np.ones_like(al),lab,range(1,n+1))
small=np.isin(lab,np.where(sizes<200)[0]+1)
al=np.where(small,0,al)
a[...,3]=al
a[al==0,:3]=0
clean=a.astype(np.uint8)
# slice 4x3 cells of 362, align feet baseline and center horizontally on idle frame per row
W,H=1086//3,1448//4
FW,FH=256,384   # output frame (taller than wide)
out=Image.new('RGBA',(FW*3,FH*4))
frames=[]
for row in range(4):
  cells=[clean[row*H:(row+1)*H, c*W:(c+1)*W] for c in range(3)]
  # bounds
  bbs=[]
  for cell in cells:
    ys,xs=np.nonzero(cell[...,3])
    bbs.append((xs.min(),xs.max(),ys.min(),ys.max()))
  idle=bbs[1]; cx=(idle[0]+idle[1])/2
  for c,(cell,bb) in enumerate(zip(cells,bbs)):
    sub=cell[bb[2]:bb[3]+1, bb[0]:bb[1]+1]
    h,w=sub.shape[:2]
    # center horizontally using row's idle center offset
    top=sub[:int(h*0.45),:,3]>0
    tx=np.nonzero(top)[1].mean()
    ox=int(round(FW/2-tx))
    oy=FH-8-h
    print(row,c,'size',w,h,'ox',ox,'oy',oy)
    out.paste(Image.fromarray(sub),(c*FW+ox,row*FH+oy),Image.fromarray(sub))
out.save('director-walk.png')
bg=Image.new('RGBA',out.size,(235,235,235,255)); Image.alpha_composite(bg,out).save('preview-light.png')
