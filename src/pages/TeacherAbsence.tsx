import { useEffect, useState } from 'react';
import { UserMinus, Plus, Pencil, Trash2, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { Modal, EmptyState, Spinner, ConfirmDialog } from '@/components/ui';
import { formatDate } from '@/lib/utils';
import type { ClassRow, TeacherAbsence } from '@/lib/types';

const TIMES: string[] = (() => {
  const out: string[] = [];
  for (let h = 7; h <= 18; h++) for (const m of ['00', '30']) out.push(`${String(h).padStart(2, '0')}:${m}`);
  return out;
})();

export default function TeacherAbsencePage() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [records, setRecords] = useState<TeacherAbsence[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ open: boolean; edit?: TeacherAbsence }>({ open: false });
  const [form, setForm] = useState({
    teacher_name: '', subject: '', record_date: new Date().toISOString().slice(0, 10),
    class_id: '', start_time: '08:00', end_time: '09:00', reason: '', notes: '',
  });
  const [confirmDel, setConfirmDel] = useState<TeacherAbsence | null>(null);

  const instId = profile?.institution_id;

  async function load() {
    if (!instId) return;
    setLoading(true);
    const { data: cls } = await supabase.from('classes').select('*').eq('institution_id', instId).order('name');
    setClasses((cls ?? []) as ClassRow[]);
    const { data } = await supabase.from('teacher_absences').select('*').eq('institution_id', instId).order('record_date', { ascending: false });
    setRecords((data ?? []) as TeacherAbsence[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, [instId]);

  const filtered = records.filter((r) =>
    r.teacher_name.toLowerCase().includes(search.toLowerCase()) ||
    (r.subject ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const className = (id: string | null) => classes.find((c) => c.id === id)?.name ?? '—';

  const openAdd = () => {
    setForm({ teacher_name: '', subject: '', record_date: new Date().toISOString().slice(0, 10), class_id: classes[0]?.id ?? '', start_time: '08:00', end_time: '09:00', reason: '', notes: '' });
    setModal({ open: true });
  };
  const openEdit = (r: TeacherAbsence) => {
    setForm({
      teacher_name: r.teacher_name, subject: r.subject ?? '', record_date: r.record_date,
      class_id: r.class_id ?? '', start_time: r.start_time ?? '08:00', end_time: r.end_time ?? '09:00',
      reason: r.reason ?? '', notes: r.notes ?? '',
    });
    setModal({ open: true, edit: r });
  };

  const save = async () => {
    if (!instId || !form.teacher_name.trim()) return;
    const payload = {
      institution_id: instId,
      class_id: form.class_id || null,
      teacher_name: form.teacher_name.trim(),
      subject: form.subject || null,
      record_date: form.record_date,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      reason: form.reason || null,
      notes: form.notes || null,
    };
    if (modal.edit) {
      await supabase.from('teacher_absences').update(payload).eq('id', modal.edit.id);
    } else {
      await supabase.from('teacher_absences').insert(payload);
    }
    setModal({ open: false });
    load();
  };

  const del = async (r: TeacherAbsence) => {
    await supabase.from('teacher_absences').delete().eq('id', r.id);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="relative flex-1 max-w-xs">
          <Search size={16} className="absolute inset-y-0 start-0 my-auto ms-3 text-muted" />
          <input className="input ps-9" placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button onClick={openAdd} className="btn btn-primary"><Plus size={18} />{t('add_teacher_absence')}</button>
      </div>

      {loading ? <Spinner label={t('loading')} /> : filtered.length === 0 ? (
        <div className="card"><EmptyState icon={<UserMinus size={40} />} text={t('empty')} /></div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="surface-2 text-muted">
              <tr>
                <th className="text-start px-3 py-2 font-medium">{t('teacher_name')}</th>
                <th className="text-start px-3 py-2 font-medium">{t('subject')}</th>
                <th className="text-start px-3 py-2 font-medium">{t('class')}</th>
                <th className="text-start px-3 py-2 font-medium">{t('date')}</th>
                <th className="text-start px-3 py-2 font-medium">{t('reason')}</th>
                <th className="text-start px-3 py-2 font-medium">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-app">
                  <td className="px-3 py-2 font-medium">{r.teacher_name}</td>
                  <td className="px-3 py-2">{r.subject ?? '—'}</td>
                  <td className="px-3 py-2">{className(r.class_id)}</td>
                  <td className="px-3 py-2">{formatDate(r.record_date, 'ar')}</td>
                  <td className="px-3 py-2 text-muted">{r.reason ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button onClick={() => openEdit(r)} className="btn btn-ghost p-1.5"><Pencil size={15} /></button>
                      {profile?.role === 'admin' && <button onClick={() => setConfirmDel(r)} className="btn btn-ghost p-1.5 text-[var(--error)]"><Trash2 size={15} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modal.open} onClose={() => setModal({ open: false })} title={modal.edit ? t('edit') : t('add_teacher_absence')}>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="label">{t('teacher_name')}</label>
            <input className="input" value={form.teacher_name} onChange={(e) => setForm({ ...form, teacher_name: e.target.value })} />
          </div>
          <div><label className="label">{t('subject')}</label><input className="input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></div>
          <div><label className="label">{t('class')}</label>
            <select className="input" value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })}>
              <option value="">—</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div><label className="label">{t('date')}</label><input type="date" className="input" value={form.record_date} onChange={(e) => setForm({ ...form, record_date: e.target.value })} /></div>
          <div><label className="label">{t('start_time')}</label>
            <select className="input" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })}>{TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}</select>
          </div>
          <div><label className="label">{t('end_time')}</label>
            <select className="input" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })}>{TIMES.map((tm) => <option key={tm} value={tm}>{tm}</option>)}</select>
          </div>
          <div className="sm:col-span-2"><label className="label">{t('reason')}</label><input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="label">{t('notes')}</label><textarea className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={() => setModal({ open: false })} className="btn btn-ghost">{t('cancel')}</button>
          <button onClick={save} className="btn btn-primary">{t('save')}</button>
        </div>
      </Modal>

      <ConfirmDialog open={!!confirmDel} onClose={() => setConfirmDel(null)} onConfirm={() => confirmDel && del(confirmDel)}
        title={t('delete')} message={confirmDel?.teacher_name ?? ''} confirmLabel={t('delete')} danger />
    </div>
  );
}
