import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, LabelList,
} from "recharts";
import QRCode from "react-qr-code";

// 🔌 Firebase 연결은 .env + src/firebase.ts 에서 처리
import { ref, onValue, set, update, runTransaction } from "firebase/database";
import { db } from "./firebase";

// ===== 상수/타입/유틸 =====
const DEFAULT_DESC = "설명을 입력하세요. 예) 체험학습 장소를 골라요!";
type Visibility = "always" | "hidden" | "deadline";
type VoteLimit = 1 | 2;
type Option = { id: string; label: string; votes: number };
type Ballot = { ids: string[]; at: number; name?: string };

function uuid() {
  return (window.crypto as any)?.randomUUID?.() || `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
function getViewMode(): "admin" | "student" {
  return window.location.hash === "#student" ? "student" : "admin";
}
function makeDefaultState() {
  const opts: Option[] = [
    { id: uuid(), label: "보기 1", votes: 0 },
    { id: uuid(), label: "보기 2", votes: 0 },
  ];
  return {
    title: "우리 반 결정 투표",
    desc: DEFAULT_DESC,
    voteLimit: 1 as VoteLimit,
    options: opts,
    ballots: {} as Record<string, Ballot>,
    anonymous: false,
    visibilityMode: "always" as Visibility,
    deadlineAt: null as number | null,
    expectedVoters: 0,
    manualClosed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// DB 경로
const pollPath = (pollId: string) => `polls/${pollId}`;

// ===== 메인 앱 =====
export default function App() {
  const [viewMode, setViewMode] = useState<"admin" | "student">(getViewMode());
  useEffect(() => {
    const onHash = () => setViewMode(getViewMode());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // URL에서 pollId 읽기(없으면 생성)
  const [pollId, setPollId] = useState<string>("");
  useEffect(() => {
    const url = new URL(window.location.href);
    let pid = url.searchParams.get("pid") || "";
    if (!pid) {
      pid = Math.random().toString(36).slice(2, 8); // 새 방
      const base = makeDefaultState();
      set(ref(db, pollPath(pid)), base);
      url.searchParams.set("pid", pid);
      window.history.replaceState({}, "", url.toString());
    }
    setPollId(pid);
  }, []);

  // 상태
  const [title, setTitle] = useState<string>("우리 반 결정 투표");
  const [desc, setDesc] = useState<string>(DEFAULT_DESC);
  const [voteLimit, setVoteLimit] = useState<VoteLimit>(1);
  const [options, setOptions] = useState<Option[]>([]);
  const [ballots, setBallots] = useState<Record<string, Ballot>>({});
  const [anonymous, setAnonymous] = useState<boolean>(false);
  const [visibilityMode, setVisibilityMode] = useState<Visibility>("always");
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [expectedVoters, setExpectedVoters] = useState<number>(0);
  const [expectedVotersText, setExpectedVotersText] = useState<string>("0");
  const [manualClosed, setManualClosed] = useState<boolean>(false);

  // 안내/링크
  const [saveHint, setSaveHint] = useState<string>("");
  const [linkVersion, setLinkVersion] = useState<number>(0);
  const [showLink, setShowLink] = useState<boolean>(false);

  // DB → 상태 실시간 구독
  useEffect(() => {
    if (!pollId) return;
    const r = ref(db, pollPath(pollId));
    return onValue(r, (snap) => {
      const data = snap.val();
      if (!data) return;
      setTitle(data.title ?? "우리 반 결정 투표");
      setDesc(data.desc ?? DEFAULT_DESC);
      setVoteLimit((data.voteLimit as VoteLimit) ?? 1);
      setOptions(Array.isArray(data.options) ? data.options : []);
      setBallots(data.ballots ?? {});
      setAnonymous(!!data.anonymous);
      setVisibilityMode((data.visibilityMode as Visibility) ?? "always");
      setDeadlineAt(data.deadlineAt ?? null);
      setExpectedVoters(Number(data.expectedVoters ?? 0));
      setExpectedVotersText(String(Number(data.expectedVoters ?? 0)));
      setManualClosed(!!data.manualClosed);
    });
  }, [pollId]);

  // 파생값
  const totalVotes = useMemo(() => options.reduce((a, b) => a + (b?.votes ?? 0), 0), [options]);
  const votedCount = useMemo(() => Object.keys(ballots).length, [ballots]);
  const autoClosed = useMemo(() => expectedVoters > 0 && votedCount >= expectedVoters, [expectedVoters, votedCount]);
  const isClosed = manualClosed || autoClosed;

  const now = Date.now();
  const baseVisible = useMemo(() => {
    if (visibilityMode === "always") return true;
    if (visibilityMode === "hidden") return false;
    if (!deadlineAt) return false;
    return now >= deadlineAt;
  }, [visibilityMode, deadlineAt, now]);

  // 요구: '항상 숨김'은 학생만 숨기고 관리자는 볼 수 있게
  const isVisibleAdmin = visibilityMode === "hidden" ? true : baseVisible;
  const isVisibleStudent = baseVisible;

  const graphData = useMemo(() => options.map((o) => ({ name: o.label, votes: o.votes })), [options]);

  // 학생용 링크 (pid 고정, v는 QR 재생성 유도)
  const studentLink = useMemo(() => {
    if (!pollId) return location.href;
    const url = new URL(window.location.href);
    url.hash = "#student";
    url.searchParams.set("pid", pollId);
    url.searchParams.set("v", String(linkVersion));
    return url.toString();
  }, [pollId, linkVersion]);

  const copyStudentLink = () =>
    navigator.clipboard.writeText(studentLink).then(() => setSaveHint("학생용 링크를 복사했어요."));

  // 공용: DB 업데이트(부분 patch)
  function patchPoll(fields: Partial<any>) {
    if (!pollId) return;
    fields.updatedAt = Date.now();
    update(ref(db, pollPath(pollId)), fields);
  }

  // 보기/설정 저장 → DB 반영 + QR/링크 버전업
  function saveToCloud() {
    patchPoll({
      title, desc, voteLimit, options, anonymous,
      visibilityMode, deadlineAt, expectedVoters, manualClosed,
    });
    setLinkVersion((v) => v + 1);
    setSaveHint("저장됨 (실시간 공유/QR/링크 반영)");
  }

  // 옵션 편집
  function setOptionLabel(id: string, label: string) {
    setOptions((prev) => {
      const next = prev.map((o) => (o.id === id ? { ...o, label } : o));
      patchPoll({ options: next });
      return next;
    });
  }
  function addOption() {
    const label = `보기 ${options.length + 1}`;
    const next = [...options, { id: uuid(), label, votes: 0 }];
    setOptions(next);
    patchPoll({ options: next });
  }
  function removeOption(id: string) {
    const next = options.filter((o) => o.id !== id);
    setOptions(next);
    // 서버 트랜잭션으로 표/투표 정합성 유지
    runTransaction(ref(db, pollPath(pollId)), (data: any) => {
      if (!data) return data;
      const ballotsObj = data.ballots || {};
      const newBallots: Record<string, Ballot> = {};
      Object.entries(ballotsObj).forEach(([k, info]: any) => {
        const ids = (info.ids || []).filter((x: string) => x !== id);
        newBallots[k] = { ...info, ids };
      });
      const countMap: Record<string, number> = {};
      next.forEach((o) => (countMap[o.id] = 0));
      Object.values(newBallots).forEach((b: any) => (b.ids || []).forEach((oid: string) => (countMap[oid] = (countMap[oid] || 0) + 1)));
      const fixedOptions = next.map((o) => ({ ...o, votes: countMap[o.id] || 0 }));
      return { ...data, options: fixedOptions, ballots: newBallots, updatedAt: Date.now() };
    });
  }
  function recountVotes() {
    runTransaction(ref(db, pollPath(pollId)), (data: any) => {
      if (!data) return data;
      const opts = data.options || [];
      const ballotsObj = data.ballots || {};
      const countMap: Record<string, number> = {};
      opts.forEach((o: any) => (countMap[o.id] = 0));
      Object.values(ballotsObj).forEach((b: any) => (b.ids || []).forEach((oid: string) => (countMap[oid] = (countMap[oid] || 0) + 1)));
      const fixed = opts.map((o: any) => ({ ...o, votes: countMap[o.id] || 0 }));
      return { ...data, options: fixed, updatedAt: Date.now() };
    });
  }

  // 투표 제출(트랜잭션)
  const [voterName, setVoterName] = useState<string>("");
  const [selected, setSelected] = useState<string[]>([]);
  function getStudentKey(): string {
    if (anonymous) {
      const k = localStorage.getItem(`vote_device_token_${pollId}`);
      if (k) return k;
      const t = uuid();
      localStorage.setItem(`vote_device_token_${pollId}`, t);
      return t;
    }
    return voterName.trim();
  }
  function submitVote() {
    if (isClosed) return alert("투표가 마감되었습니다.");
    const key = getStudentKey();
    if (!key) return alert("이름/번호를 입력하세요.");
    if (selected.length === 0) return alert("선택한 보기가 없습니다.");

    runTransaction(ref(db, pollPath(pollId)), (data: any) => {
      if (!data) return data;
      const ballotsObj = data.ballots || {};
      if (ballotsObj[key]) return data; // 중복 방지
      const ids = selected.slice(0, data.voteLimit || 1);
      const nowMs = Date.now();
      ballotsObj[key] = { ids, at: nowMs, name: data.anonymous ? undefined : (voterName.trim() || undefined) };
      const opts = (data.options || []).map((o: any) => ({ ...o }));
      ids.forEach((id: string) => {
        const idx = opts.findIndex((o: any) => o.id === id);
        if (idx >= 0) opts[idx].votes = (opts[idx].votes || 0) + 1;
      });
      return { ...data, ballots: ballotsObj, options: opts, updatedAt: Date.now() };
    }).then((res) => {
      if (res.committed) {
        setVoterName("");
        setSelected([]);
      } else {
        alert("이미 투표했습니다.");
      }
    });
  }

  // 투표자 삭제
  function removeVoter(id: string) {
    if (!confirm(`${id}의 투표를 삭제할까요?`)) return;
    runTransaction(ref(db, pollPath(pollId)), (data: any) => {
      if (!data) return data;
      const ballotsObj = { ...(data.ballots || {}) };
      const info = ballotsObj[id];
      if (!info) return data;
      delete ballotsObj[id];
      const opts = (data.options || []).map((o: any) => ({ ...o }));
      (info.ids || []).forEach((oid: string) => {
        const idx = opts.findIndex((o: any) => o.id === oid);
        if (idx >= 0) opts[idx].votes = Math.max(0, (opts[idx].votes || 0) - 1);
      });
      return { ...data, ballots: ballotsObj, options: opts, updatedAt: Date.now() };
    });
  }

  // 전체 초기화
  function resetAllToDefaults() {
    if (!confirm("모든 설정과 결과를 기본값으로 초기화할까요? (현재 방의 데이터가 삭제됩니다)")) return;
    const fresh = makeDefaultState();
    set(ref(db, pollPath(pollId)), fresh);
    setSaveHint("기본값으로 초기화됨");
    setLinkVersion((v) => v + 1);
  }

  // 마감/재개
  const closeNow = () => patchPoll({ manualClosed: true });
  const reopen = () => patchPoll({ manualClosed: false });

  // CSV/JSON 저장(다운로드)
  function download(filename: string, text: string, mime = "application/json") {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
  function saveJSON() {
    const payload = JSON.stringify(
      { title, desc, voteLimit, options, ballots, anonymous, visibilityMode, deadlineAt, expectedVoters, manualClosed, pollId },
      null, 2
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-result-${stamp}.json`, payload, "application/json");
    setSaveHint("JSON으로 저장했어요.");
  }
  function saveCSV() {
    const head = "option,votes\n";
    const rows = options.map((o) => `${escapeCSV(o.label)},${o.votes}`).join("\n");
    const csv = head + rows;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-summary-${stamp}.csv`, csv, "text/csv");
    setSaveHint("CSV 요약을 저장했어요.");
  }
  function escapeCSV(s: string) {
    if (s == null) return "";
    const needs = /[",\n]/.test(s);
    const out = String(s).replace(/"/g, '""');
    return needs ? `"${out}"` : out;
  }

  // 투표 인원 입력(문자열 → 숫자)
  const onExpectedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setExpectedVotersText(raw);
    const digits = raw.replace(/\D/g, "");
    const num = digits === "" ? 0 : parseInt(digits, 10);
    setExpectedVoters(num);
    patchPoll({ expectedVoters: num });
  };

  // ===== 렌더 =====
  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50 text-gray-900">
      {/* 상단바 */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600 text-white grid place-items-center font-bold shadow">V</div>
            <div>
              {viewMode === "admin" ? (
                <input
                  className="text-xl md:text-2xl font-semibold bg-transparent border-b border-transparent focus:border-indigo-400 outline-none px-1 rounded"
                  value={title}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setTitle(e.target.value); patchPoll({ title: e.target.value }); }}
                  aria-label="제목"
                />
              ) : (
                <div className="text-xl md:text-2xl font-semibold">{title}</div>
              )}
              <div className="text-xs text-gray-500">실시간 동기화 / 1·2표 / QR 학생화면 / 결과공개 제어 / 자동마감</div>
            </div>
          </div>

          {viewMode === "admin" ? (
            <div className="flex items-center gap-2">
              <button onClick={saveJSON} className="px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow">JSON 저장</button>
              <button onClick={saveCSV} className="px-3 py-2 rounded-xl bg-white border hover:bg-gray-50 shadow">CSV 저장</button>
            </div>
          ) : (
            <div className="text-xs text-gray-500">학생 화면</div>
          )}
        </div>

        {viewMode === "admin" && (
          <div className="border-t bg-gradient-to-r from-indigo-50 to-purple-50">
            <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
              <span className="px-2 py-1 rounded-full bg-white border text-gray-700">투표 {votedCount}{expectedVoters > 0 ? `/${expectedVoters}` : ""}</span>
              {isClosed ? (
                <span className="px-2 py-1 rounded-full bg-rose-100 text-rose-700 border">마감됨</span>
              ) : (
                <span className="px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 border">진행중</span>
              )}
              <div className="flex-1 h-2 bg-white/60 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500" style={{ width: `${expectedVoters ? Math.min(100, (votedCount / expectedVoters) * 100) : 0}%` }} />
              </div>
            </div>
          </div>
        )}
      </header>

      {viewMode === "admin" ? (
        <AdminView
          {...{
            desc, setDesc: (v: string) => { setDesc(v); patchPoll({ desc: v }); },
            voteLimit, setVoteLimit: (v: VoteLimit) => { setVoteLimit(v); patchPoll({ voteLimit: v }); },
            options, setOptionLabel, addOption, removeOption, recountVotes,
            ballots, anonymous, setAnonymous: (b: boolean) => { setAnonymous(b); patchPoll({ anonymous: b }); },
            visibilityMode, setVisibilityMode: (m: Visibility) => { setVisibilityMode(m); patchPoll({ visibilityMode: m }); },
            deadlineAt, setDeadlineAt: (t: number | null) => { setDeadlineAt(t); patchPoll({ deadlineAt: t }); },
            totalVotes, graphData, isVisible: isVisibleAdmin,
            expectedVotersText, onExpectedChange,
            isClosed, closeNow, reopen,
            saveHint, saveToCloud,
            studentLink, copyStudentLink,
            showLink, setShowLink,
            resetAllToDefaults,
            removeVoter,
          }}
        />
      ) : (
        <StudentView
          {...{
            desc, options, voteLimit, anonymous,
            visibilityMode, deadlineAt, isVisible: isVisibleStudent,
            voterName, setVoterName, selected, setSelected, submitVote,
            totalVotes, graphData, isClosed,
          }}
        />
      )}

      <footer className="max-w-6xl mx-auto px-4 pb-10 text-xs text-gray-400">
        방 ID: <span className="font-mono">{pollId}</span> · Made for classroom by 교무
      </footer>
    </div>
  );
}

// ===== 관리자 화면 =====
function AdminView(props: any) {
  const {
    desc, setDesc,
    voteLimit, setVoteLimit,
    options, setOptionLabel, addOption, removeOption, recountVotes,
    ballots, anonymous, setAnonymous,
    visibilityMode, setVisibilityMode, deadlineAt, setDeadlineAt,
    totalVotes, graphData, isVisible,
    expectedVotersText, onExpectedChange,
    isClosed, closeNow, reopen,
    saveHint, saveToCloud,
    studentLink, copyStudentLink,
    showLink, setShowLink,
    resetAllToDefaults,
    removeVoter,
  } = props;

  const votedCount = Object.keys(ballots || {}).length;
  const ballotEntries: Array<[string, Ballot]> = Object.entries(ballots || {}) as any;

  return (
    <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-5 gap-6">
      {/* 왼쪽: 설정 & 투표 관리 */}
      <section className="lg:col-span-2 space-y-6">
        {/* 설명 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <label className="text-sm text-gray-500">설명</label>
          <textarea
            value={desc}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDesc(e.target.value)}
            onFocus={() => { if (desc === DEFAULT_DESC) setDesc(""); }}
            className="w-full mt-2 p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-300"
            rows={3}
            placeholder={DEFAULT_DESC}
          />

          <div className="mt-4 grid grid-cols-1 gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">투표 방식</span>
                <select
                  value={voteLimit}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVoteLimit(Number(e.target.value) as VoteLimit)}
                  className="border rounded-lg px-2 py-1"
                >
                  <option value={1}>1인 1표</option>
                  <option value={2}>1인 2표</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-500">익명 모드</label>
                <input
                  type="checkbox"
                  className="scale-110"
                  checked={anonymous}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAnonymous(e.target.checked)}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">결과 공개</span>
                <select
                  value={visibilityMode}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVisibilityMode(e.target.value as Visibility)}
                  className="border rounded-lg px-2 py-1"
                >
                  <option value="always">항상 공개</option>
                  <option value="hidden">항상 숨김(학생만)</option>
                  <option value="deadline">마감 후 공개</option>
                </select>
                {visibilityMode === "deadline" && (
                  <input
                    type="datetime-local"
                    className="border rounded-lg px-2 py-1"
                    value={deadlineAt ? new Date(deadlineAt).toISOString().slice(0, 16) : ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeadlineAt(e.target.value ? new Date(e.target.value).getTime() : null)}
                  />
                )}
              </div>
            </div>

            {/* 투표 인원 / 마감 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">투표 인원</span>
                <input
                  type="text" inputMode="numeric" pattern="[0-9]*"
                  className="w-24 border rounded-lg px-2 py-1"
                  value={expectedVotersText}
                  onChange={onExpectedChange}
                  placeholder="예: 25"
                />
                <span className="text-xs text-gray-500">빈 칸 가능 · 0=자동마감 없음</span>
              </div>
              <div className="flex items-center gap-2">
                {!isClosed ? (
                  <button onClick={closeNow} className="px-2 py-1 text-xs rounded-md bg-rose-600 text-white hover:bg-rose-700 shadow">마감</button>
                ) : (
                  <button onClick={reopen} className="px-2 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 shadow">재개</button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-sm text-gray-500">
              <div>참여: <span className="font-semibold">{votedCount}</span> · 총 표수: <span className="font-semibold">{totalVotes}</span></div>
              <div>{saveHint}</div>
            </div>
          </div>
        </div>

        {/* 보기(옵션) */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">보기(옵션)</h2>
            <div className="flex items-center gap-2">
              <button onClick={addOption} className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">추가</button>
              <button onClick={saveToCloud} className="px-3 py-1.5 text-sm rounded-lg bg-white border hover:bg-gray-50" title="현재 옵션/설정을 DB에 저장하고 QR/링크를 갱신합니다">저장</button>
            </div>
          </div>
          <ul className="mt-3 space-y-2">
            {options.map((o: Option) => (
              <li key={o.id} className="flex items-center gap-2">
                <input className="flex-1 border rounded-lg px-2 py-1" value={o.label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOptionLabel(o.id, e.target.value)} />
                <span className="text-xs text-gray-500 w-14 text-right">{o.votes} 표</span>
                <button onClick={() => removeOption(o.id)} className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50">삭제</button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
            <button onClick={resetAllToDefaults} className="px-3 py-1.5 rounded-lg bg-white border hover:bg-gray-50">전체 초기화</button>
            <button onClick={recountVotes} className="px-3 py-1.5 rounded-lg bg-white border hover:bg-gray-50">표 재계산</button>
          </div>
        </div>

        {/* 학생용 링크 & QR */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">학생용 화면 링크</h2>
            <div className="flex items-center gap-2">
              <button onClick={saveToCloud} className="px-3 py-1.5 text-sm rounded-lg bg-white border hover:bg-gray-50">저장</button>
              <button onClick={() => setShowLink((v: boolean) => !v)} className="px-3 py-1.5 text-sm rounded-lg bg-white border hover:bg-gray-50">{showLink ? "숨기기" : "주소 보기"}</button>
              <a href={studentLink} className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">열기</a>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
            <div className="flex items-center justify-center p-3 bg-gray-50 rounded-xl border">
              <QRCode value={studentLink} size={160} />
            </div>
            <div className="text-sm text-gray-600 leading-relaxed">
              {!showLink ? (
                <p className="text-xs text-gray-500">주소는 숨김 상태입니다. <span className="font-medium">[주소 보기]</span>로 확인하거나 <span className="font-medium">복사</span>하세요.</p>
              ) : (
                <div className="space-y-2">
                  <input value={studentLink} readOnly className="w-full text-xs border rounded-lg px-2 py-1 break-all" onFocus={(e) => e.currentTarget.select()} />
                  <div className="flex gap-2">
                    <button onClick={copyStudentLink} className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50">복사</button>
                    <button onClick={() => setShowLink(false)} className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50">숨기기</button>
                  </div>
                </div>
              )}
              <p className="mt-2 text-xs text-gray-500">같은 방(pid)으로 접속한 모든 기기의 결과가 실시간으로 동기화됩니다.</p>
            </div>
          </div>
        </div>

        {/* 투표자 목록 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">투표자 목록</h2>
          </div>
          {(ballotEntries.length === 0) ? (
            <p className="text-sm text-gray-500 mt-2">아직 투표가 없습니다.</p>
          ) : (
            <ul className="mt-2 max-h-48 overflow-auto divide-y">
              {ballotEntries.map(([id, info]) => (
                <li key={id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <div className="font-medium">{info?.name || id}</div>
                    <div className="text-xs text-gray-500">{new Date(info.at).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-gray-500">{info.ids?.join(", ")}</div>
                    <button onClick={() => removeVoter(id)} className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50">삭제</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* 오른쪽: 실시간 결과 */}
      <section className="lg:col-span-3 space-y-6">
        <div className="bg-white rounded-2xl shadow p-4 h-[460px]">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">실시간 결과</h2>
            <div className="text-sm text-gray-500">참여 {votedCount} · 총 {totalVotes}표</div>
          </div>
          <div className="w-full h-[400px]">
            {isVisible ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={graphData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                  <defs>
                    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366F1" stopOpacity="1" />
                      <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.9" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                  <XAxis dataKey="name" interval={0} angle={-10} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} />
                  <Tooltip formatter={(v: number) => `${v} 표`} />
                  <Bar dataKey="votes" fill="url(#barGrad)" radius={[10, 10, 0, 0]} barSize={36} isAnimationActive animationDuration={700} animationEasing="ease-out">
                    <LabelList dataKey="votes" position="top" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full grid place-items-center text-gray-400">결과 비공개 상태입니다.</div>
            )}
          </div>
          {isClosed && (
            <div className="mt-3 p-3 rounded-xl bg-rose-50 text-rose-700 text-sm border border-rose-100">투표가 마감되었습니다. 재개하려면 "재개" 버튼을 누르세요.</div>
          )}
        </div>

        <div className="bg-indigo-50 rounded-2xl border border-indigo-100 p-4">
          <h3 className="font-semibold">진행 팁</h3>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>QR/링크에 포함된 <code>?pid=방ID</code> 로 접속한 모든 기기는 같은 결과를 공유합니다.</li>
            <li>새로고침은 서버 결과를 그대로 불러오므로 누계가 유지됩니다.</li>
            <li>“전체 초기화”만 데이터가 0으로 리셋됩니다.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}

// ===== 학생 화면 =====
function StudentView(props: any) {
  const {
    desc, options, voteLimit, anonymous,
    visibilityMode, deadlineAt, isVisible,
    voterName, setVoterName, selected, setSelected,
    submitVote, totalVotes, graphData, isClosed,
  } = props;

  const [submitted, setSubmitted] = useState<boolean>(false);
  const onSubmit = () => { submitVote(); setSubmitted(true); };

  return (
    <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="bg-white rounded-2xl shadow p-4">
        <div className="text-sm text-gray-500">안내</div>
        <div className="mt-1 whitespace-pre-wrap">{desc}</div>
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        {isClosed && (
          <div className="mb-3 p-3 rounded-xl bg-rose-50 text-rose-700 text-sm border border-rose-100">
            투표가 마감되어 더 이상 제출할 수 없습니다.
          </div>
        )}

        {!anonymous && (
          <div className="mb-3">
            <label className="text-sm text-gray-500">이름/번호</label>
            <input
              value={voterName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoterName(e.target.value)}
              placeholder="이름 또는 번호"
              className="mt-1 w-full border rounded-lg px-3 py-2"
              disabled={isClosed}
            />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {options.map((o: Option) => {
            const checked = selected.includes(o.id);
            const disabled = isClosed || (!checked && selected.length >= voteLimit);
            return (
              <button
                key={o.id}
                onClick={() =>
                  setSelected((prev: string[]) => {
                    if (isClosed) return prev;
                    if (prev.includes(o.id)) return prev.filter((x: string) => x !== o.id);
                    if (prev.length >= voteLimit) return prev;
                    return [...prev, o.id];
                  })
                }
                className={`text-left p-3 rounded-xl border transition ${checked ? "bg-indigo-50 border-indigo-300" : "bg-white hover:bg-gray-50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                disabled={disabled}
              >
                <div className="font-medium">{o.label}</div>
                <div className="text-xs text-gray-500">{checked ? "선택됨" : `선택 가능 (${selected.length}/${voteLimit})`}</div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <a href="#admin" className="text-xs text-gray-400 underline">관리자 화면</a>
          <button onClick={onSubmit} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isClosed}>제출</button>
        </div>

        {submitted && <div className="mt-3 text-sm text-emerald-700">제출되었습니다. 감사합니다!</div>}
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">결과</h2>
          <div className="text-sm text-gray-500">총 {totalVotes}표</div>
        </div>
        <div className="w-full h-[320px]">
          {isVisible ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={graphData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                <defs>
                  <linearGradient id="barGradS" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366F1" stopOpacity="1" />
                    <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.9" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                <XAxis dataKey="name" interval={0} angle={-10} textAnchor="end" height={50} />
                <YAxis allowDecimals={false} />
                <Tooltip formatter={(v: number) => `${v} 표`} />
                <Bar dataKey="votes" fill="url(#barGradS)" radius={[10, 10, 0, 0]} barSize={32} isAnimationActive animationDuration={700} animationEasing="ease-out">
                  <LabelList dataKey="votes" position="top" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full grid place-items-center text-gray-400">
              {visibilityMode === "deadline" && deadlineAt ? (
                <div className="text-center">
                  <div>결과는 발표 전 비공개입니다.</div>
                  <div className="text-xs mt-1">공개 예정: {new Date(deadlineAt).toLocaleString()}</div>
                </div>
              ) : (
                <div>결과 비공개 상태입니다.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
