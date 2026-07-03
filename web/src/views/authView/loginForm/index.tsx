import { useState, type FormEvent } from 'react';
import { UserOutlined, LockOutlined, LoginOutlined } from '@ant-design/icons';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { loginApi } from './api.tsx';
import { login } from '@/store/userStore';
import { useLang } from '@/i18n';
import { useToast } from '@/globalComponents/toast';
import TextInput from '@/globalComponents/textInput';
import PasswordInput from '@/globalComponents/passwordInput';
import Button from '@/globalComponents/button';
import Checkbox from '@/globalComponents/checkbox';
import { type LoginFormModel } from './type.tsx';
import styles from './style.module.scss';

interface FieldErr { username?: string; password?: string }

function LoginForm({ switchModel }: { switchModel: () => void }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useLang();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FieldErr>({});

  function validate(values: LoginFormModel): FieldErr {
    const e: FieldErr = {};
    if (!values.username)            e.username = t('auth.validate.usernameRequired');
    else if (values.username.length < 2) e.username = t('auth.validate.usernameMin');
    if (!values.password)            e.password = t('auth.validate.passwordRequired');
    else if (values.password.length < 6) e.password = t('auth.validate.passwordRule');
    return e;
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const values: LoginFormModel = { username, password, remember };
    const err = validate(values);
    setErrors(err);
    if (Object.keys(err).length) {
      toast.err(t('common.invalid'));
      return;
    }
    setLoading(true);
    try {
      const result = await loginApi(values);
      const data = result.data;
      if (!data) throw new Error('login: missing user data');
      dispatch(login({
        id: data.id, username: data.username, nickname: data.nickname,
        email: data.email, avatar: data.avatar, bio: data.bio, phone: data.phone,
        status: data.status, gender: data.gender, createdAt: data.createdAt, updatedAt: data.updatedAt,
        lastSeen: data.lastSeen,
      }));
      toast.ok(t('auth.login.ok'));
      navigate('/chat');
    } catch {
      toast.err(t('auth.login.fail'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.card}>
      {/* <div className={styles.head}>
        <h2 className={styles.title}>{t('auth.login.title')}</h2>
        <p className={styles.sub}>{t('auth.login.sub')}</p>
      </div> */}

      <form noValidate onSubmit={onSubmit} className={styles.form}>
        <TextInput
          label={t('auth.fields.username')}
          autoComplete="username"
          prefix={<UserOutlined />}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
        />
        <PasswordInput
          label={t('auth.fields.password')}
          autoComplete="current-password"
          prefix={<LockOutlined />}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />

        <div className={styles.row}>
          <Checkbox checked={remember} onChange={setRemember}>
            {t('auth.fields.remember')}
          </Checkbox>
          <Button variant="link" size="sm" type="button">{t('auth.fields.forgot')}</Button>
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={loading}
          icon={<LoginOutlined />}
        >
          {loading ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>

      <div className={styles.foot}>
        <Button variant="link" onClick={switchModel} type="button">
          {t('auth.login.switchToSignup')}
        </Button>
      </div>
    </div>
  );
}

export default LoginForm;
