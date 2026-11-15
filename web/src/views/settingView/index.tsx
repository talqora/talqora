import settingStyle from './style.module.scss';
import { Image as AntdImage } from 'antd';
import { useSelector, useDispatch } from 'react-redux';
import { useState, useRef } from 'react';
import { uploadImg } from './api';
import { updateProfile } from '@/store/userStore';
import CropperModal from '@/globalComponents/cropperModal/cropperModal';
import { updateUserInfo } from '@/globalApi/userApi';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar } from '@/assets/images';
import type { RootState } from '@/store/rootStore';
import { useLang } from '@/i18n';
import { useToast } from '@/globalComponents/toast';
import { useTheme, type ThemeMode } from '@/style/theme';

function SettingView({ onClose }: { onClose: () => void }) {
    const { t, lang, setLang } = useLang();
    const { mode, setMode } = useTheme();
    const toast = useToast();
    const themeOptions: ThemeMode[] = ['light', 'dark', 'system'];
    const [loading, setLoading] = useState(false);
    const dispatch = useDispatch();
    const inputRef = useRef<HTMLInputElement>(null);
    const [cropModalOpen, setCropModalOpen] = useState(false);
    const [rawImage, setRawImage] = useState<string>('');
    const user = useSelector((state: RootState) => state.user);

    // 上传头像
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                setRawImage(ev.target?.result as string);
                setCropModalOpen(true);
            };
            reader.readAsDataURL(file);
        }
    };

    // 裁剪完成后上传
    const handleCropOk = (croppedBlob: Blob) => {
        const formData = new FormData();
        formData.append('file', croppedBlob, 'avatar.jpg');
        setLoading(true);
        uploadImg(formData).then(res => {
            const uploadResult = res.data;
            if (!uploadResult) {
                toast.err(t('settings.avatar.missingUrl'));
                setLoading(false);
                return;
            }
            dispatch(updateProfile({ avatar: uploadResult.url }));
            updateUserInfo({ id: user.id, avatar: uploadResult.url });
            setLoading(false);
        }).catch(err => {
            setLoading(false);
            console.log(err);
        });
        setCropModalOpen(false);
    };

    const handleClickUpload = () => inputRef.current?.click();
    const handleClose = () => onClose();

    return (
        <div className={settingStyle.setting_view_mask}>
            <div className={settingStyle.setting_view}>
                <div className={settingStyle.setting_view_title}>
                    <p>{t('settings.title')}</p>
                    <i className={`iconfont icon-close ${settingStyle.icon_close}`} onClick={handleClose}></i>
                </div>

                <div className={settingStyle.setting_view_body}>
                    {/* 左侧 */}
                    <div className={settingStyle.setting_view_left}>
                        <AntdImage width={72} src={user.avatar ? buildServerUrl(user.avatar) : defaultAvatar} />
                        <input
                            ref={inputRef}
                            type="file"
                            style={{ display: 'none' }}
                            accept="image/png, image/jpeg"
                            onChange={handleChange}
                        />
                        <button
                            className={settingStyle.setting_view_upload_button}
                            type="button"
                            onClick={handleClickUpload}
                        >
                            {loading ? t('settings.avatar.uploading') : t('settings.avatar.change')}
                        </button>
                        <CropperModal
                            open={cropModalOpen}
                            image={rawImage}
                            onCancel={() => setCropModalOpen(false)}
                            onOk={handleCropOk}
                        />
                    </div>

                    {/* 右侧 */}
                    <div className={settingStyle.setting_view_right}>
                        <div className={settingStyle.row}>
                            <div className={settingStyle.rowKey}>{t('settings.language.title')}</div>
                            <div className={settingStyle.langSwitch} role="tablist">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={lang === 'zh'}
                                    className={lang === 'zh' ? settingStyle.langOn : settingStyle.langOff}
                                    onClick={() => setLang('zh')}
                                >
                                    {t('settings.language.zh')}
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={lang === 'en'}
                                    className={lang === 'en' ? settingStyle.langOn : settingStyle.langOff}
                                    onClick={() => setLang('en')}
                                >
                                    {t('settings.language.en')}
                                </button>
                            </div>
                        </div>

                        <div className={settingStyle.row}>
                            <div className={settingStyle.rowKey}>{t('settings.theme.title')}</div>
                            <div className={settingStyle.langSwitch} role="tablist">
                                {themeOptions.map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        role="tab"
                                        aria-selected={mode === m}
                                        className={mode === m ? settingStyle.langOn : settingStyle.langOff}
                                        onClick={() => setMode(m)}
                                    >
                                        {t(`settings.theme.${m}`)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default SettingView;
