import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, LabelList, Cell,
} from "recharts";
import QRCode from "react-qr-code";
import { ref, onValue, set, update, runTransaction } from "firebase/database";
import type { DataSnapshot } from "firebase/database";
import { db, ensureAuth } from "./firebase";

/* ========= Types & utils ========= */
type Visibility = "always" | "hidden" | "deadline";
type VoteLimit = 1 | 2;
type Option = { id: string; label: string; votes: number };
type Ballot = { ids: string[]; at: number; name?: string | null };
type GraphDatum = { name: string; votes: number; _i: number };

const DEFAULT_DESC = "설명을 입력하세요. 예) 체험학습 장소를 골라요!";
const LS_PID_KEY = "vote_last_pid";
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN; // 환경변수에서 관리자 PIN 로드

const uuid = () =>
  (window.crypto as any)?.randomUUID?.() ||
  `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const getView = (): "admin" | "student" =>
  location.hash === "#student" ? "student" : "admin";

const pollPath = (pid: string) => `polls/${pid}`;

const getPidFromURL = (): string => {
  try { return new URL(location.href).searchParams.get("pid") || ""; }
  catch { return ""; }
};

const defaultState = () => {
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
};

/* ========= Color palette for bars ========= */
const COLORS = [
  "#6366F1", "#10B981", "#F59E0B", "#EF4444", "#06B6D4",
  "#A855F7", "#84CC16", "#3B82F6", "#EC4899", "#F97316",
];

/* ========= Interfaces ========= */
interface AdminViewProps {
  desc: string;
  setDesc: (v: string) => Promise<void>;
  voteLimit: VoteLimit;
  setVoteLimit: (v: VoteLimit) => Promise<void>;
  options: Option[];
  setOptionLabel: (id: string, label: string) => void;
  addOption: () => Promise<void>;
  removeOption: (id: string) => Promise<void>;
  recountVotes: () => Promise<void>;
  ballots: Record<string, Ballot>;
  anonymous: boolean;
  setAnonymous: (b: boolean) => Promise<void>;
  visibilityMode: Visibility;
  setVisibilityMode: (m: Visibility) => Promise<void>;
  deadlineAt: number | null;
  setDeadlineAt: (t: number | null) => Promise<void>;
  totalVotes: number;
  graphData: GraphDatum[];
  isVisible: boolean;
  expectedVotersText: string;
  onExpectedChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  isClosed: boolean;
  closeNow: () => Promise<void>;
  reopen: () => Promise<void>;
  saveHint: string;
  saveToCloud: () => Promise<void>;
  studentLink: string;
  copyStudentLink: () => void;
  showLink: boolean;
  setShowLink: React.Dispatch<React.SetStateAction<boolean>>;
  resetAllToDefaults: () => Promise<void>;
  removeVoter: (id: string) => Promise<void>;
  isWorking: boolean;
}

interface StudentViewProps {
  desc: string;
  options: Option[];
  voteLimit: VoteLimit;
  anonymous: boolean;
  visibilityMode: Visibility;
  deadlineAt: number | null;
  isVisible: boolean;
  voterName: string;
  setVoterName: (v: string) => void;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  submitVote: () => Promise<boolean>;
  totalVotes: number;
  graphData: GraphDatum[];
  isClosed: boolean;
  pidReady: boolean;
  isWorking: boolean;
}

/* ========= App ========= */
export default function App() {
  const [viewMode, setViewMode] = useState<"admin" | "student">(getView());
  const [adminAuthed, setAdminAuthed] = useState(!ADMIN_PIN); 
  const [pinInput, setPinInput] = useState("");

  useEffect(() => {
    const onHash = () => setViewMode(getView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [isBooting, setIsBooting] = useState(true);
  const [isWorking, setIsWorking] = useState(false);

  const [pollId, setPollId] = useState<string>("");

  const [title, setTitle] = useState("우리 반 결정 투표");
  const [desc, setDesc] = useState(DEFAULT_DESC);
  const [voteLimit, setVoteLimit] = useState<VoteLimit>(1);
  const [options, setOptions] = useState<Option[]>([]);
  const [ballots, setBallots] = useState<Record<string, Ballot>>({});
  const [anonymous, setAnonymous] = useState(false);
  const [visibilityMode, setVisibilityMode] = useState<Visibility>("always");
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [expectedVoters, setExpectedVoters] = useState(0);
  const [expectedVotersText, setExpectedVotersText] = useState("0");
  const [manualClosed, setManualClosed] = useState(false);

  const [saveHint, setSaveHint] = useState("");
  const [linkVersion, setLinkVersion] = useState(0);
  const [showLink, setShowLink] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- Timer for real-time deadline check ---------- */
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000); 
    return () => clearInterval(timer);
  }, []);

  /* ---------- pid helpers ---------- */
  const getActivePid = useCallback((): string =>
    pollId || getPidFromURL() || localStorage.getItem(LS_PID_KEY) || "", [pollId]);

  const setPidEverywhere = (pid: string) => {
    if (!pid) return;
    setPollId(pid);
    localStorage.setItem(LS_PID_KEY, pid);
    const u = new URL(location.href);
    u.searchParams.set("pid", pid);
    history.replaceState({}, "", u.toString());
  };

  const ensurePid = async (): Promise<string> => {
    await ensureAuth();
    let pid = getActivePid();
    if (pid) return pid;
    setIsWorking(true);
    try {
      pid = Math.random().toString(36).slice(2, 8);
      await set(ref(db, pollPath(pid)), defaultState());
      setPidEverywhere(pid);
      setLinkVersion((v) => v + 1);
      return pid;
    } finally {
      setIsWorking(false);
    }
  };

  const patchPoll = async (fields: Partial<any>) => {
    await ensureAuth();
    const pid = getActivePid();
    if (!pid) return;
    await update(ref(db, pollPath(pid)), { ...fields, updatedAt: Date.now() });
  };

  /* ---------- boot & subscribe ---------- */
  useEffect(() => {
    let unsub: (() => void) | undefined;

    async function boot() {
      try {
        await ensureAuth();
        let pid = getPidFromURL() || localStorage.getItem(LS_PID_KEY) || "";
        if (!pid) {
          pid = Math.random().toString(36).slice(2, 8);
          await set(ref(db, pollPath(pid)), defaultState());
        }
        setPidEverywhere(pid);

        const r = ref(db, pollPath(pid));
        unsub = onValue(
          r,
          (snap: DataSnapshot) => {
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
            const ev = Number(data.expectedVoters ?? 0);
            const evSafe = isNaN(ev) ? 0 : ev;
            setExpectedVoters(evSafe);
            setExpectedVotersText(String(evSafe));
            setManualClosed(!!data.manualClosed);
            setPidEverywhere(pid);
            setIsBooting(false);
          },
          (err) => {
            console.error("구독 실패:", err);
            setIsBooting(false);
          }
        );
      } catch (e) {
        console.error("초기화 실패", e);
        setOptions(defaultState().options);
        setIsBooting(false);
      }
    }

    boot();
    return () => { if (unsub) unsub(); };
  }, []);

  /* ---------- derived ---------- */
  const totalVotes = useMemo(
    () => options.reduce((a: number, b: Option) => a + (b?.votes ?? 0), 0),
    [options]
  );
  const votedCount = useMemo(() => Object.keys(ballots).length, [ballots]);
  const autoClosed = useMemo(
    () => expectedVoters > 0 && votedCount >= expectedVoters,
    [expectedVoters, votedCount]
  );
  const isClosed = manualClosed || autoClosed;

  const baseVisible = useMemo(() => {
    if (visibilityMode === "always") return true;
    if (visibilityMode === "hidden") return false;
    if (!deadlineAt) return false;
    return now >= deadlineAt;
  }, [visibilityMode, deadlineAt, now]);

  const isVisibleAdmin = visibilityMode === "hidden" ? true : baseVisible;
  const isVisibleStudent = baseVisible;

  const graphData: GraphDatum[] = useMemo(
    () => options.map((o: Option, idx) => ({ name: o.label, votes: o.votes, _i: idx })),
    [options]
  );

  /* ---------- student link / QR ---------- */
  const studentLink = useMemo(() => {
    const pid = getActivePid();
    const u = new URL(location.href);
    if (pid) u.searchParams.set("pid", pid);
    u.hash = "#student";
    u.searchParams.set("v", String(linkVersion));
    return u.toString();
  }, [getActivePid, linkVersion]);

  const copyStudentLink = () =>
    navigator.clipboard.writeText(studentLink).then(() => setSaveHint("학생용 링크를 복사했어요."));

  /* ---------- save / mutate ---------- */
  const saveToCloud = async () => {
    try {
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();
      await update(ref(db, pollPath(pid)), {
        title, desc, voteLimit, options, anonymous,
        visibilityMode, deadlineAt, expectedVoters, manualClosed,
        updatedAt: Date.now(),
      });
      setLinkVersion((v) => v + 1);
      setSaveHint("저장됨 (QR/링크 반영)");
    } catch (e) {
      console.error(e);
      alert("저장 중 문제가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  const addOption = async () => {
    try {
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();

      await runTransaction(ref(db, pollPath(pid)), (data: any) => {
        const d = data || defaultState();
        const current: Option[] = Array.isArray(d.options) ? d.options : [];
        const nextIndex = current.length + 1;
        const newItem: Option = { id: uuid(), label: `보기 ${nextIndex}`, votes: 0 };
        const next: Option[] = [...current, newItem];
        return { ...d, options: next, updatedAt: Date.now() };
      });

      setSaveHint("옵션을 추가했어요.");
      setLinkVersion((v) => v + 1);
    } catch (e) {
      console.error(e);
      alert("옵션 추가 중 문제가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setOptionLabel = (id: string, label: string) => {
    setOptions((prev: Option[]) => {
      const next = prev.map((o: Option) => (o.id === id ? { ...o, label } : o));
      
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        void patchPoll({ options: next });
      }, 500); 

      return next;
    });
  };

  const removeOption = async (id: string) => {
    try {
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();

      await runTransaction(ref(db, pollPath(pid)), (data: any) => {
        if (!data) return data;
        const current: Option[] = Array.isArray(data.options) ? data.options : [];
        const next: Option[] = current.filter((o: Option) => o.id !== id);

        const ballotsObj = data.ballots || {};
        const newBallots: Record<string, Ballot> = {};
        Object.entries(ballotsObj).forEach(([k, info]) => {
          const b = info as Ballot;
          newBallots[k] = { ...b, ids: (b.ids || []).filter((x) => x !== id) };
        });

        const countMap: Record<string, number> = {};
        next.forEach((o: Option) => (countMap[o.id] = 0));
        Object.values(newBallots).forEach((b) =>
          (b.ids || []).forEach((oid) => (countMap[oid] = (countMap[oid] || 0) + 1))
        );

        const fixedOptions: Option[] = next.map((o: Option) => ({ ...o, votes: countMap[o.id] || 0 }));
        return { ...data, options: fixedOptions, ballots: newBallots, updatedAt: Date.now() };
      });

      setSaveHint("옵션을 삭제했어요.");
      setLinkVersion((v) => v + 1);
    } catch (e) {
      console.error(e);
      alert("옵션 삭제 중 문제가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  const recountVotes = async () => {
    try {
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();
      await runTransaction(ref(db, pollPath(pid)), (data: any) => {
        if (!data) return data;
        const opts: Option[] = data.options || [];
        const ballotsObj = data.ballots || {};
        const countMap: Record<string, number> = {};
        opts.forEach((o: Option) => (countMap[o.id] = 0));
        Object.values(ballotsObj).forEach((b: any) =>
          (b.ids || []).forEach((oid: string) => (countMap[oid] = (countMap[oid] || 0) + 1))
        );
        const fixed: Option[] = opts.map((o: Option) => ({ ...o, votes: countMap[o.id] || 0 }));
        return { ...data, options: fixed, updatedAt: Date.now() };
      });
      setSaveHint("표를 재계산했어요.");
    } catch (e) {
      console.error(e);
      alert("재계산 중 오류가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- vote submit ---------- */
  const [voterName, setVoterName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const getStudentKey = (pid: string, isAnonymous: boolean): string => {
    if (isAnonymous) {
      const keyName = `vote_device_token_${pid || "temp"}`;
      let key: string = localStorage.getItem(keyName) || "";
      if (!key) {
        key = uuid();
        localStorage.setItem(keyName, key);
      }
      return key;
    }
    return voterName.trim();
  };

  const submitVote = async (): Promise<boolean> => {
    try {
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();

      const key = getStudentKey(pid, anonymous);
      if (!key) { alert("이름/번호를 입력하세요."); return false; }
      if (selected.length === 0) { alert("선택한 보기가 없습니다."); return false; }

      const res = await runTransaction(ref(db, pollPath(pid)), (data: any) => {
        if (!data) return data;
        
        if (data.manualClosed || (data.expectedVoters > 0 && Object.keys(data.ballots || {}).length >= data.expectedVoters)) {
          return; 
        }

        const ballotsObj = data.ballots || {};
        if (ballotsObj[key]) return data; 

        const ids = selected.slice(0, data.voteLimit || 1);
        const nowMs = Date.now();

        ballotsObj[key] = {
          ids,
          at: nowMs,
          name: data.anonymous ? null : (voterName.trim() || null),
        };

        const opts: Option[] = (data.options || []).map((o: Option) => ({ ...o }));
        ids.forEach((oid: string) => {
          const idx = opts.findIndex((o: Option) => o.id === oid);
          if (idx >= 0) opts[idx].votes = (opts[idx].votes || 0) + 1;
        });

        return { ...data, ballots: ballotsObj, options: opts, updatedAt: Date.now() };
      });

      if ((res as any)?.committed) {
        setVoterName("");
        setSelected([]);
        return true;
      } else {
        alert("이미 투표했거나 마감되었습니다.");
        return false;
      }
    } catch (e) {
      console.error(e);
      alert("제출 중 오류가 발생했습니다.");
      return false;
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- remove voter ---------- */
  const removeVoter = async (id: string) => {
    try {
      if (!confirm(`${id}의 투표를 삭제할까요?`)) return;
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();

      await runTransaction(ref(db, pollPath(pid)), (data: any) => {
        if (!data) return data;
        const ballotsObj = { ...(data.ballots || {}) };
        const info = ballotsObj[id] as Ballot | undefined;
        if (!info) return data;
        delete ballotsObj[id];

        const opts: Option[] = (data.options || []).map((o: Option) => ({ ...o }));
        (info.ids || []).forEach((oid: string) => {
          const idx = opts.findIndex((o: Option) => o.id === oid);
          if (idx >= 0) opts[idx].votes = Math.max(0, (opts[idx].votes || 0) - 1);
        });

        return { ...data, ballots: ballotsObj, options: opts, updatedAt: Date.now() };
      });
    } catch (e) {
      console.error(e);
      alert("투표 삭제 중 오류가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- reset to defaults ---------- */
  const resetAllToDefaults = async () => {
    try {
      if (!confirm("모든 설정과 결과를 기본값으로 초기화할까요?")) return;
      setIsWorking(true);
      await ensureAuth();
      const pid = await ensurePid();
      await set(ref(db, pollPath(pid)), defaultState());

      const d = defaultState();
      setTitle(d.title);
      setDesc(d.desc);
      setVoteLimit(d.voteLimit);
      setOptions(d.options);
      setBallots(d.ballots);
      setAnonymous(d.anonymous);
      setVisibilityMode(d.visibilityMode);
      setDeadlineAt(d.deadlineAt);
      setExpectedVoters(d.expectedVoters);
      setExpectedVotersText(String(d.expectedVoters));
      setManualClosed(d.manualClosed);

      setPidEverywhere(pid);
      setLinkVersion((v) => v + 1);
      setSaveHint("기본값으로 초기화됨");
    } catch (e) {
      console.error(e);
      alert("초기화 중 오류가 발생했습니다.");
    } finally {
      setIsWorking(false);
    }
  };

  /* ---------- close / reopen ---------- */
  const closeNow = async () => {
    await ensureAuth();
    const pid = await ensurePid();
    await update(ref(db, pollPath(pid)), { manualClosed: true, updatedAt: Date.now() });
  };
  const reopen = async () => {
    await ensureAuth();
    const pid = await ensurePid();
    await update(ref(db, pollPath(pid)), { manualClosed: false, updatedAt: Date.now() });
  };

  /* ---------- JSON / CSV / load ---------- */
  const download = (filename: string, text: string, mime = "application/json") => {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const saveJSON = () => {
    const payload = JSON.stringify(
      {
        title, desc, voteLimit, options, ballots,
        anonymous, visibilityMode, deadlineAt,
        expectedVoters, manualClosed, pollId: getActivePid(),
      },
      null, 2
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-result-${stamp}.json`, payload, "application/json");
    setSaveHint("JSON으로 저장했어요.");
  };

  const saveCSV = () => {
    const head = "option,votes\n";
    const rows = options.map((o: Option) => `${escapeCSV(o.label)},${o.votes}`).join("\n");
    const csv = head + rows;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`vote-summary-${stamp}.csv`, csv, "text/csv");
    setSaveHint("CSV 요약을 저장했어요.");
  };

  const escapeCSV = (s: string) => {
    if (s == null) return "";
    const needs = /[",\n]/.test(s);
    const out = String(s).replace(/"/g, '""');
    return needs ? `"${out}"` : out;
  };

  const loadFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(String(ev.target?.result || "{}"));
        if (typeof data.title === "string") setTitle(data.title);
        if (typeof data.desc === "string") setDesc(data.desc);
        if (data.voteLimit === 1 || data.voteLimit === 2) setVoteLimit(data.voteLimit as VoteLimit);
        if (Array.isArray(data.options)) setOptions(data.options as Option[]);
        if (data.ballots && typeof data.ballots === "object") setBallots(data.ballots as Record<string, Ballot>);
        if (typeof data.anonymous === "boolean") setAnonymous(data.anonymous);
        if (data.visibilityMode) setVisibilityMode(data.visibilityMode as Visibility);
        setDeadlineAt(data.deadlineAt ?? null);

        const evNum = Number(data.expectedVoters ?? 0);
        const evSafe = isNaN(evNum) ? 0 : evNum;
        setExpectedVoters(evSafe);
        setExpectedVotersText(String(evSafe));
        setManualClosed(!!data.manualClosed);

        void patchPoll({
          title: data.title, desc: data.desc, voteLimit: data.voteLimit, options: data.options,
          ballots: data.ballots, anonymous: data.anonymous, visibilityMode: data.visibilityMode,
          deadlineAt: data.deadlineAt ?? null, expectedVoters: evSafe, manualClosed: !!data.manualClosed,
        });
        setLinkVersion((v) => v + 1);
        setSaveHint("JSON에서 불러왔어요.");
      } catch {
        alert("불러오기에 실패했어요. JSON 형식을 확인하세요.");
      }
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  };

  if (isBooting) {
    return <div className="min-h-screen grid place-items-center text-gray-500">초기화 중입니다…</div>;
  }

  if (viewMode === "admin" && !adminAuthed) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-white to-gray-50 flex items-center justify-center px-4">
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            if (pinInput === ADMIN_PIN) setAdminAuthed(true);
            else alert("비밀번호가 일치하지 않습니다.");
          }} 
          className="bg-white p-6 sm:p-8 rounded-2xl shadow-lg flex flex-col gap-4 max-w-sm w-full"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600 text-white grid place-items-center font-bold shadow">V</div>
            <h2 className="text-xl font-bold text-gray-800">관리자 접속</h2>
          </div>
          <p className="text-sm text-gray-500">설정된 관리자 비밀번호(PIN)를 입력하세요.</p>
          <input 
            type="password" 
            placeholder="비밀번호 입력" 
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            className="border p-3 rounded-xl outline-none focus:ring-2 focus:ring-indigo-300 text-base"
          />
          <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white p-3 rounded-xl shadow mt-2 transition">
            인증하기
          </button>
        </form>
      </div>
    );
  }

  const pidReady = !!getActivePid();

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50 text-gray-900">
      {/* 상단바 */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 shrink-0 rounded-2xl bg-indigo-600 text-white grid place-items-center font-bold shadow">V</div>
            <div className="min-w-0">
              {viewMode === "admin" ? (
                <input
                  className="text-lg sm:text-xl md:text-2xl font-semibold bg-transparent border-b border-transparent focus:border-indigo-400 outline-none px-1 rounded w-full truncate"
                  value={title}
                  onChange={async (e: React.ChangeEvent<HTMLInputElement>) => {
                    const v = e.target.value;
                    setTitle(v);
                    await patchPoll({ title: v });
                  }}
                  aria-label="제목"
                />
              ) : (
                <div className="text-lg sm:text-xl md:text-2xl font-semibold truncate">{title}</div>
              )}
              <div className="text-[10px] sm:text-xs text-gray-500 truncate">실시간 동기화 / 1·2표 / QR 학생화면 / 결과공개 제어 / 자동마감</div>
            </div>
          </div>

          {viewMode === "admin" ? (
            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <button onClick={saveJSON} className="px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow text-sm" disabled={isWorking}>JSON</button>
              <button onClick={saveCSV} className="px-3 py-2 rounded-xl bg-white border hover:bg-gray-50 shadow text-sm" disabled={isWorking}>CSV</button>
              <button onClick={() => fileInputRef.current?.click()} className="px-3 py-2 rounded-xl bg-white border hover:bg-gray-50 shadow text-sm" disabled={isWorking}>로드</button>
              <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={loadFromFile} />
            </div>
          ) : (
            <div className="text-xs text-gray-500 shrink-0">학생 화면</div>
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
                <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${expectedVoters ? Math.min(100, (votedCount / expectedVoters) * 100) : 0}%` }} />
              </div>
            </div>
          </div>
        )}
      </header>

      {viewMode === "admin" ? (
        <AdminView
          {...{
            desc,
            setDesc: async (v: string) => { setDesc(v); await patchPoll({ desc: v }); },
            voteLimit,
            setVoteLimit: async (v: VoteLimit) => { setVoteLimit(v); await patchPoll({ voteLimit: v }); },
            options, setOptionLabel, addOption, removeOption, recountVotes,
            ballots,
            anonymous, setAnonymous: async (b: boolean) => { setAnonymous(b); await patchPoll({ anonymous: b }); },
            visibilityMode,
            setVisibilityMode: async (m: Visibility) => { setVisibilityMode(m); await patchPoll({ visibilityMode: m }); },
            deadlineAt,
            setDeadlineAt: async (t: number | null) => { setDeadlineAt(t); await patchPoll({ deadlineAt: t }); },
            totalVotes, graphData, isVisible: isVisibleAdmin,
            expectedVotersText,
            onExpectedChange: async (e: React.ChangeEvent<HTMLInputElement>) => {
              const raw = e.target.value ?? "";
              setExpectedVotersText(raw);
              const num = raw.replace(/\D/g, "");
              const safe = num === "" ? 0 : parseInt(num, 10);
              setExpectedVoters(safe);
              await patchPoll({ expectedVoters: safe });
            },
            isClosed, closeNow, reopen,
            saveHint, saveToCloud,
            studentLink, copyStudentLink,
            showLink, setShowLink,
            resetAllToDefaults,
            removeVoter,
            isWorking,
          }}
        />
      ) : (
        <StudentView
          {...{
            desc, options, voteLimit, anonymous,
            visibilityMode, deadlineAt, isVisible: isVisibleStudent,
            voterName, setVoterName, selected, setSelected, submitVote,
            totalVotes, graphData, isClosed,
            pidReady: !!getActivePid(),
            isWorking,
          }}
        />
      )}

      <footer className="max-w-6xl mx-auto px-4 pb-10 text-xs text-gray-400 text-center sm:text-left">
        방 ID: <span className="font-mono">{getActivePid()}</span> · Made for classroom by 교무
      </footer>
    </div>
  );
}

/* ========= Admin ========= */
function AdminView(props: AdminViewProps) {
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
    isWorking,
  } = props;

  const votedCount = Object.keys(ballots || {}).length;
  const ballotEntries: Array<[string, Ballot]> = Object.entries(ballots || {}) as any;

  return (
    <main className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 grid lg:grid-cols-5 gap-4 sm:gap-6">
      {/* 왼쪽: 설정 */}
      <section className="lg:col-span-2 space-y-4 sm:space-y-6">
        {/* 설명 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <label className="text-sm text-gray-500">설명</label>
          <textarea
            value={desc}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDesc(e.target.value)}
            onFocus={() => { if (desc === DEFAULT_DESC) setDesc(""); }}
            className="w-full mt-2 p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-300 text-sm sm:text-base"
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
                  className="border rounded-lg px-2 py-1 text-sm sm:text-base"
                  disabled={isWorking}
                >
                  <option value={1}>1인 1표</option>
                  <option value={2}>1인 2표</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-500">익명 모드</label>
                <input type="checkbox" className="scale-125" checked={anonymous} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAnonymous(e.target.checked)} disabled={isWorking} />
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <span className="text-sm text-gray-500">결과 공개</span>
                <select
                  value={visibilityMode}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVisibilityMode(e.target.value as Visibility)}
                  className="border rounded-lg px-2 py-1 text-sm sm:text-base flex-1 sm:flex-none"
                  disabled={isWorking}
                >
                  <option value="always">항상 공개</option>
                  <option value="hidden">항상 숨김</option>
                  <option value="deadline">마감 후</option>
                </select>
              </div>
              {visibilityMode === "deadline" && (
                <div className="w-full">
                  <input
                    type="datetime-local"
                    className="border rounded-lg px-2 py-1 text-sm sm:text-base w-full"
                    value={deadlineAt ? new Date(deadlineAt).toISOString().slice(0, 16) : ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeadlineAt(e.target.value ? new Date(e.target.value).getTime() : null)}
                    disabled={isWorking}
                  />
                </div>
              )}
            </div>

            {/* 투표 인원 / 마감 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">투표 인원</span>
                <input
                  type="text" inputMode="numeric" pattern="[0-9]*"
                  className="w-20 sm:w-24 border rounded-lg px-2 py-1 text-sm sm:text-base"
                  value={expectedVotersText}
                  onChange={onExpectedChange}
                  placeholder="예: 25"
                  disabled={isWorking}
                />
                <span className="text-xs text-gray-400">0=자동마감 안함</span>
              </div>
              <div className="flex items-center gap-2">
                {!isClosed ? (
                  <button onClick={closeNow} className="px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 shadow" disabled={isWorking}>마감</button>
                ) : (
                  <button onClick={reopen} className="px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow" disabled={isWorking}>재개</button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between text-xs sm:text-sm text-gray-500 mt-2">
              <div>참여: <span className="font-semibold">{votedCount}</span> · 총 표수: <span className="font-semibold">{totalVotes}</span></div>
              <div className="text-emerald-600 font-medium">{saveHint}</div>
            </div>
          </div>
        </div>

        {/* 보기(옵션) */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">보기(옵션)</h2>
            <div className="flex items-center gap-2">
              <button onClick={addOption} className="px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700" disabled={isWorking}>추가</button>
              <button onClick={saveToCloud} className="px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-white border hover:bg-gray-50" disabled={isWorking}>저장</button>
            </div>
          </div>
          <ul className="mt-3 space-y-2">
            {options.map((o: Option, idx: number) => (
              <li key={o.id} className="flex items-center gap-2">
                <span
                  className="h-5 w-5 shrink-0 rounded-md border"
                  style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                />
                <input className="flex-1 border rounded-lg px-2 py-1.5 text-sm sm:text-base min-w-0" value={o.label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOptionLabel(o.id, e.target.value)} disabled={isWorking} />
                <span className="text-xs text-gray-500 w-10 sm:w-14 text-right shrink-0">{o.votes}표</span>
                <button onClick={() => removeOption(o.id)} className="px-2 py-1 text-xs rounded-md bg-rose-50 text-rose-600 border border-rose-100 hover:bg-rose-100 shrink-0" disabled={isWorking}>삭제</button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
            <button onClick={resetAllToDefaults} className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs sm:text-sm" disabled={isWorking}>전체 초기화</button>
            <button onClick={recountVotes} className="px-3 py-1.5 rounded-lg bg-white border hover:bg-gray-50 text-xs sm:text-sm" disabled={isWorking}>표 재계산</button>
          </div>
        </div>

        {/* 학생 링크 & QR */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">학생용 접속</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowLink((v: boolean) => !v)} className="px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-white border hover:bg-gray-50">{showLink ? "숨기기" : "주소 보기"}</button>
              <a href={studentLink} className="px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">열기</a>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div className="flex items-center justify-center p-4 bg-gray-50 rounded-xl border">
              <QRCode value={studentLink} size={140} className="w-full max-w-[140px] h-auto" />
            </div>
            <div className="text-sm text-gray-600 leading-relaxed">
              {!showLink ? (
                <p className="text-xs sm:text-sm text-gray-500">주소는 숨김 상태입니다. <span className="font-medium">[주소 보기]</span>로 확인하세요.</p>
              ) : (
                <div className="space-y-2">
                  <input value={studentLink} readOnly className="w-full text-xs border rounded-lg px-2 py-2 bg-gray-50 break-all" onFocus={(e) => e.currentTarget.select()} />
                  <div className="flex gap-2">
                    <button onClick={copyStudentLink} className="flex-1 py-1.5 text-xs rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 font-medium">주소 복사</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 투표자 목록 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">투표자 목록 ({ballotEntries.length}명)</h2>
          </div>
          {ballotEntries.length === 0 ? (
            <p className="text-sm text-gray-500 mt-3 text-center py-4 bg-gray-50 rounded-xl">아직 투표가 없습니다.</p>
          ) : (
            <ul className="mt-3 max-h-48 overflow-y-auto divide-y pr-2">
              {ballotEntries.map(([id, info]) => (
                <li key={id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="min-w-0 pr-2">
                    <div className="font-medium truncate">{info?.name || id}</div>
                    <div className="text-xs text-gray-400">{new Date(info.at).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-xs text-gray-500 truncate max-w-[80px] sm:max-w-[150px]">{(info.ids || []).join(", ")}</div>
                    <button onClick={() => removeVoter(id)} className="px-2 py-1 text-xs rounded-md bg-white border hover:bg-gray-50" disabled={isWorking}>삭제</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* 오른쪽: 실시간 결과 */}
      <section className="lg:col-span-3 space-y-4 sm:space-y-6">
        <div className="bg-white rounded-2xl shadow p-4 flex flex-col h-[400px] sm:h-[460px]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">실시간 결과</h2>
            <div className="text-sm text-gray-500">참여 {votedCount} · 총 {totalVotes}표</div>
          </div>
          <div className="flex-1 w-full min-h-0">
            {isVisible ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={graphData} margin={{ top: 20, right: 10, bottom: 20, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                  <XAxis
                    dataKey="name"
                    interval={0}
                    angle={-15}
                    textAnchor="end"
                    height={40}
                    tick={{ fontSize: 12, fill: '#6B7280', fontFamily: "Inter, system-ui, sans-serif" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: '#6B7280', fontFamily: "Inter, system-ui, sans-serif" }}
                    axisLine={false}
                    tickLine={false}
                    width={30}
                  />
                  <Tooltip formatter={(v: number) => [`${v} 표`, '득표수']} cursor={{fill: '#F3F4F6'}} />
                  <Bar
                    dataKey="votes"
                    radius={[6, 6, 0, 0]}
                    barSize={40}
                    isAnimationActive
                    animationDuration={700}
                    animationEasing="ease-out"
                  >
                    {graphData.map((d: GraphDatum) => (
                      <Cell key={d._i} fill={COLORS[d._i % COLORS.length]} />
                    ))}
                    <LabelList
                      dataKey="votes"
                      position="top"
                      style={{ fontSize: 12, fill: '#4B5563', fontWeight: 600, fontFamily: "Inter, system-ui, sans-serif" }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 bg-gray-50 rounded-xl">
                <svg className="w-12 h-12 mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                결과 비공개 상태입니다
              </div>
            )}
          </div>
        </div>

        <div className="bg-indigo-50 rounded-2xl border border-indigo-100 p-4">
          <h3 className="font-semibold text-indigo-900">💡 진행 팁</h3>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1.5 text-indigo-800/80">
            <li>링크나 QR의 <code>?pid=방ID</code>가 같으면 모든 기기에서 결과가 하나로 합쳐집니다.</li>
            <li>새로고침을 해도 서버 데이터를 불러와 누계가 그대로 유지됩니다.</li>
            <li><span className="font-semibold">전체 초기화</span>를 눌러야만 투표수가 0으로 리셋됩니다.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}

/* ========= Student ========= */
function StudentView(props: StudentViewProps) {
  const {
    desc, options, voteLimit, anonymous,
    visibilityMode, deadlineAt, isVisible,
    voterName, setVoterName, selected, setSelected,
    submitVote, totalVotes, graphData, isClosed,
    pidReady, isWorking,
  } = props;

  const [submitted, setSubmitted] = useState(false);
  
  const onSubmit = async () => { 
    const success = await submitVote(); 
    if (success) {
      setSubmitted(true); 
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
      {!pidReady && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-xl text-sm font-medium text-center shadow-sm">
          방에 연결되지 않았습니다. QR 코드나 링크로 다시 접속해 주세요.
        </div>
      )}

      {/* 안내 영역 */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6">
        <div className="text-xs font-bold text-indigo-500 mb-2 tracking-wider">안내사항</div>
        <div className="text-base sm:text-lg whitespace-pre-wrap text-gray-800 leading-relaxed">{desc}</div>
      </div>

      {/* 투표 폼 영역 */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6">
        {isClosed && (
          <div className="mb-5 p-4 rounded-xl bg-rose-50 text-rose-700 text-sm border border-rose-100 font-medium text-center">
            투표가 마감되어 더 이상 제출할 수 없습니다.
          </div>
        )}

        {!anonymous && (
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-2">이름 또는 번호</label>
            <input
              value={voterName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoterName(e.target.value)}
              placeholder="여기에 입력하세요"
              className="w-full border border-gray-300 rounded-xl px-4 py-3 sm:py-3 text-base outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow bg-gray-50 focus:bg-white"
              disabled={isClosed || isWorking || submitted}
            />
          </div>
        )}

        <div className="mb-3 flex items-center justify-between">
          <label className="text-sm font-semibold text-gray-700">항목 선택 <span className="text-indigo-500 font-normal ml-1">({selected.length}/{voteLimit})</span></label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {options.map((o: Option) => {
            const checked = selected.includes(o.id);
            const disabled = isClosed || isWorking || submitted || (!checked && selected.length >= voteLimit);
            return (
              <button
                key={o.id}
                onClick={() =>
                  setSelected((prev: string[]) => {
                    if (isClosed || isWorking || submitted) return prev;
                    if (prev.includes(o.id)) return prev.filter((x: string) => x !== o.id);
                    if (prev.length >= voteLimit) return prev;
                    return [...prev, o.id];
                  })
                }
                className={`relative text-left p-4 sm:p-5 rounded-xl border-2 transition-all duration-200 
                  ${checked 
                    ? "bg-indigo-50 border-indigo-500 shadow-sm" 
                    : "bg-white border-gray-200 hover:border-indigo-300 hover:bg-gray-50"} 
                  ${disabled && !checked ? "opacity-50 cursor-not-allowed bg-gray-50" : ""}
                  ${disabled && checked ? "cursor-default" : ""}
                `}
                disabled={disabled}
              >
                <div className={`font-semibold text-base sm:text-lg pr-6 ${checked ? "text-indigo-900" : "text-gray-800"}`}>
                  {o.label}
                </div>
                {checked && (
                  <div className="absolute top-1/2 -translate-y-1/2 right-4 text-indigo-500">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-8 flex items-center justify-between pt-4 border-t border-gray-100">
          <a href="#admin" className="text-xs text-gray-400 hover:text-gray-600 underline px-2 py-1">관리자 설정</a>
          <button
            onClick={onSubmit}
            className={`px-8 py-3.5 rounded-xl font-bold text-white shadow-sm transition-all
              ${submitted 
                ? "bg-gray-400 cursor-default" 
                : "bg-emerald-600 hover:bg-emerald-700 hover:shadow-md active:transform active:scale-95"}
              ${(isClosed || !pidReady || isWorking) && !submitted ? "opacity-50 cursor-not-allowed" : ""}
            `}
            disabled={isClosed || !pidReady || isWorking || submitted}
          >
            {submitted ? "제출 완료" : "투표 제출하기"}
          </button>
        </div>

        {submitted && (
          <div className="mt-4 p-4 bg-emerald-50 border border-emerald-100 rounded-xl text-center">
            <p className="text-sm font-semibold text-emerald-800">✅ 투표가 성공적으로 제출되었습니다!</p>
          </div>
        )}
      </div>

      {/* 결과 영역 (모바일에서 높이 최적화) */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 sm:p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-800">현재 결과</h2>
          <div className="text-sm font-medium px-3 py-1 bg-gray-100 rounded-full text-gray-600">총 {totalVotes}표</div>
        </div>
        
        {/* 모바일 250px, 태블릿/PC 320px 로 높이 반응형 */}
        <div className="w-full h-[250px] sm:h-[320px]">
          {isVisible ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={graphData} margin={{ top: 20, right: 10, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.35} vertical={false} />
                <XAxis
                  dataKey="name"
                  interval={0}
                  angle={-15}
                  textAnchor="end"
                  height={40}
                  tick={{ fontSize: 12, fill: '#6B7280', fontFamily: "Inter, system-ui, sans-serif" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 12, fill: '#6B7280', fontFamily: "Inter, system-ui, sans-serif" }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip formatter={(v: number) => [`${v} 표`, '득표수']} cursor={{fill: '#F3F4F6'}} />
                <Bar
                  dataKey="votes"
                  radius={[6, 6, 0, 0]}
                  barSize={40}
                  isAnimationActive
                  animationDuration={700}
                  animationEasing="ease-out"
                >
                  {graphData.map((d: GraphDatum) => (
                    <Cell key={d._i} fill={COLORS[d._i % COLORS.length]} />
                  ))}
                  <LabelList
                    dataKey="votes"
                    position="top"
                    style={{ fontSize: 12, fill: '#4B5563', fontWeight: 600, fontFamily: "Inter, system-ui, sans-serif" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 bg-gray-50 rounded-xl">
              {visibilityMode === "deadline" && deadlineAt ? (
                <div className="text-center">
                  <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="font-medium">결과는 마감 후 공개됩니다</div>
                  <div className="text-xs mt-1.5 text-gray-400 border border-gray-200 inline-block px-2 py-1 rounded">
                    공개 예정: {new Date(deadlineAt).toLocaleString()}
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <svg className="w-10 h-10 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                  <div className="font-medium">결과 비공개 상태입니다</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
