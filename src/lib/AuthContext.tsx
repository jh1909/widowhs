import React, { createContext, useContext, useState, useEffect } from "react";
import { supabase } from "./supabase";

export type User = {
  id: string;
  username: string;
  discriminator?: string;
  avatar_url?: string;
};

type AuthContextType = {
  user: User | null;
  login: () => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let hasEnsuredUser = false;

    const ensurePlayerExists = async (discordName: string, userId: string) => {
      if (hasEnsuredUser) return;
      hasEnsuredUser = true;

      try {
        // 1. Check if the player already exists in the database by user_id
        const { data: userById, error: userByIdError } = await supabase
          .from('players')
          .select('user_id, name')
          .eq('user_id', userId)
          .maybeSingle();

        if (userByIdError && userByIdError.code !== 'PGRST116') {
          console.error("Error checking player by id:", userByIdError);
        }

        if (userById) {
          // Update the context with the saved name, rather than the Discord name
          setUser(prev => prev ? { ...prev, username: userById.name } : null);
          return;
        }

        // 2. If not found by user_id, search by their Discord name to link an old profile
        let { data: userByName, error: selectError } = await supabase
          .from('players')
          .select('user_id, name')
          .ilike('name', discordName)
          .maybeSingle();

        if (selectError && selectError.code !== 'PGRST116') {
          console.error("Error checking player by name:", selectError);
          return;
        }

        // 3. If data exists but user_id is null, link it
        if (userByName && !userByName.user_id) {
          await supabase.from('players').update({ user_id: userId }).eq('name', userByName.name);
          setUser(prev => prev ? { ...prev, username: userByName.name } : null);
          return;
        }
        
        let finalName = discordName;
        // If the name is already taken by someone else
        if (userByName && userByName.user_id && userByName.user_id !== userId) {
          finalName = `${discordName}_${Math.floor(Math.random() * 10000)}`;
        }

        // 4. If no data exists, insert a new placeholder profile
        const { error: insertError } = await supabase.from('players').insert([{
          name: finalName,
          user_id: userId,
          matches: 0,
          winrate: "-",
          hs: "-",
          elo: "-",
          rank: 999999
        }]);

        if (insertError) {
          console.error("Error inserting player:", insertError);
        } else {
          setUser(prev => prev ? { ...prev, username: finalName } : null);
        }
      } catch (err) {
        console.error("Unexpected error ensuring player exists:", err);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const username = session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User';
        setUser({
          id: session.user.id,
          username: username,
          avatar_url: session.user.user_metadata?.avatar_url
        });
        
        ensurePlayerExists(username, session.user.id);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const username = session.user.user_metadata?.full_name || session.user.user_metadata?.name || 'User';
        setUser({
          id: session.user.id,
          username: username,
          avatar_url: session.user.user_metadata?.avatar_url
        });

        ensurePlayerExists(username, session.user.id);
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = async () => {
    // Determine the redirect URL dynamically to support deployment properly
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    
    await supabase.auth.signInWithOAuth({
      provider: 'discord',
      options: {
        redirectTo
      }
    });
  };

  const logout = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

