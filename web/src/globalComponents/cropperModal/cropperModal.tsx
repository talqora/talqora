//图片裁剪组件
// client/src/globalComponents/cropper.tsx
import { useState, type FC } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { Modal, Slider } from 'antd';
import { useIsMobile } from '@/hooks/useIsMobile';

function getCroppedImg(imageSrc: string, croppedAreaPixels: Area): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.src = imageSrc;
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = croppedAreaPixels.width;
      canvas.height = croppedAreaPixels.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(
        image,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0,
        0,
        croppedAreaPixels.width,
        croppedAreaPixels.height
      );
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('裁剪失败'));
      }, 'image/jpeg');
    };
    image.onerror = reject;
  });
}

interface CropperModalProps {
  open: boolean;
  image: string;
  onCancel: () => void;
  onOk: (croppedBlob: Blob) => void;
}

const CropperModal: FC<CropperModalProps> = ({ open, image, onCancel, onOk }) => {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const isMobile = useIsMobile(); // 移动端弹窗近全宽(width 是 antd 内联 style,只能走 prop)

  const onCropComplete = (_croppedArea: Area, currentCroppedAreaPixels: Area) => {
    setCroppedAreaPixels(currentCroppedAreaPixels);
  };

  const handleOk = async () => {
    if (!croppedAreaPixels) return;
    const croppedBlob = await getCroppedImg(image, croppedAreaPixels);
    onOk(croppedBlob);
  };

  return (
    <Modal open={open} onCancel={onCancel} onOk={handleOk} width={isMobile ? '92vw' : 400} destroyOnHidden>
      <div style={{ position: 'relative', width: '100%', height: 300, background: '#333' }}>
        <Cropper
          image={image}
          crop={crop}
          zoom={zoom}
          aspect={1}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropComplete}
        />
      </div>
      <Slider
        min={1}
        max={3}
        step={0.1}
        value={zoom}
        onChange={setZoom}
        style={{ marginTop: 16 }}
      />
    </Modal>
  );
};

export default CropperModal;