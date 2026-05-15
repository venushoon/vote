import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { PollData } from '../types';
// import { doc, updateDoc, runTransaction } from 'firebase/firestore'; // 실제 Firebase 임포트 필요

export const useVote = (pollId: string) => {
  const [poll, setPoll] = useState<PollData | null>(null);
  
  // 1. 실시간 now 타이머 (deadline 모드 자동 갱신)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000); // 30초마다 갱신
    return () => clearInterval(timer);
  }, []);

  // 학생용 공유 링크 생성 (정확한 의존성 배열)
  const studentLink = useMemo(() => {
    return `${window.location.origin}/?pid=${pollId}`;
  }, [pollId]);

  // DB 업데이트 함수 (Mock)
  const updatePoll = useCallback(async (updates: Partial<PollData>) => {
    // await updateDoc(doc(db, "polls", pollId), updates);
    setPoll(prev => prev ? { ...prev, ...updates } : null);
  }, [pollId]);

  // 2. 디바운스가 적용된 옵션 텍스트 수정 (Firebase 요금 낭비 방지)
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const setOptionLabel = useCallback((id: string, label: string) => {
    setPoll(prev => {
      if (!prev) return prev;
      const nextOptions = prev.options.map(opt => opt.id === id ? { ...opt, label } : opt);
      
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        updatePoll({ options: nextOptions });
      }, 500);
      
      return { ...prev, options: nextOptions };
    });
  }, [updatePoll]);

  // 3. 트랜잭션 기반 투표 제출 (로컬 state 의존 탈피)
  const submitVote = useCallback(async (optionId: string) => {
    try {
      let deviceToken = localStorage.getItem('deviceToken');
      if (!deviceToken) {
        // 브루트포스 방지를 위해 crypto.randomUUID 사용
        deviceToken = crypto.randomUUID(); 
        localStorage.setItem('deviceToken', deviceToken);
      }

      // Firebase 트랜잭션 로직 예시 (실제 연동 시 활성화)
      /*
      await runTransaction(db, async (transaction) => {
        const pollDoc = await transaction.get(doc(db, "polls", pollId));
        if (!pollDoc.exists()) throw new Error("투표가 존재하지 않습니다.");
        const data = pollDoc.data();
        if (data.manualClosed || (data.expectedVoters > 0 && Object.keys(data.ballots || {}).length >= data.expectedVoters)) {
          throw new Error("마감된 투표입니다.");
        }
        transaction.update(doc(db, "polls", pollId), {
          [`ballots.${deviceToken}`]: optionId
        });
      });
      */
      
      return { committed: true };
    } catch (error: any) {
      return { committed: false, error: error.message };
    }
  }, [pollId]);

  // JSON 파일 검증 로드
  const loadFromFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (Array.isArray(data) && data.every(opt => opt.id && typeof opt.label === 'string')) {
          updatePoll({ options: data });
        } else {
          alert("유효하지 않은 파일 구조입니다.");
        }
      } catch (err) {
        alert("JSON 파싱 오류입니다. 올바른 파일인지 확인해주세요.");
      }
    };
    reader.readAsText(file);
  }, [updatePoll]);

  return { poll, now, studentLink, setOptionLabel, updatePoll, submitVote, loadFromFile };
};
