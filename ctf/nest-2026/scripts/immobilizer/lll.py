from fractions import Fraction

def _gs(B):
    d = len(B); m = len(B[0])
    Bs = []
    mu = [[Fraction(0) for _ in range(d)] for _ in range(d)]
    for i in range(d):
        v = [Fraction(x) for x in B[i]]
        for j in range(i):
            num = sum(Fraction(B[i][k])*Bs[j][k] for k in range(m))
            den = sum(x*x for x in Bs[j])
            mu[i][j] = num/den
            v = [v[k] - mu[i][j]*Bs[j][k] for k in range(m)]
        Bs.append(v)
    return Bs, mu

def _round_frac(x):
    # nearest integer (ties away from zero)
    if x >= 0:
        return int(x + Fraction(1,2)) if (x - int(x)) != Fraction(1,2) else int(x)+1
    else:
        y = -x
        return -_round_frac(y)

def lll(B, delta=Fraction(3,4), verbose=False):
    B = [[int(x) for x in row] for row in B]
    n = len(B)
    Bs, mu = _gs(B)
    Bn = [sum(x*x for x in Bs[i]) for i in range(n)]
    k = 1
    it = 0
    while k < n:
        it += 1
        # size reduce
        for j in range(k-1, -1, -1):
            if abs(mu[k][j]) > Fraction(1,2):
                q = _round_frac(mu[k][j])
                B[k] = [B[k][t] - q*B[j][t] for t in range(len(B[0]))]
                for l in range(j):
                    mu[k][l] -= q*mu[j][l]
                mu[k][j] -= q
        if Bn[k] >= (delta - mu[k][k-1]*mu[k][k-1]) * Bn[k-1]:
            k += 1
        else:
            mukk1 = mu[k][k-1]
            Bk = Bn[k]; Bk1 = Bn[k-1]
            newB = Bk + mukk1*mukk1*Bk1
            B[k], B[k-1] = B[k-1], B[k]
            mu[k][k-1] = mukk1 * Bk1 / newB
            Bn[k] = Bk * Bk1 / newB
            Bn[k-1] = newB
            for j in range(k-1):
                mu[k][j], mu[k-1][j] = mu[k-1][j], mu[k][j]
            for i in range(k+1, n):
                t = mu[i][k]
                mu[i][k] = mu[i][k-1] - mukk1*t
                mu[i][k-1] = t + mu[k][k-1]*mu[i][k]
            k = max(k-1, 1)
        if verbose and it % 1000 == 0:
            print('it', it, 'k', k, flush=True)
    return B, it

if __name__ == '__main__':
    from sympy import Matrix
    import random
    random.seed(1)
    for trial in range(3):
        d=5; m=6
        B=[[random.randint(-20,20) for _ in range(m)] for _ in range(d)]
        # ensure full rank via adding identity-ish
        for i in range(d): B[i][i] += 100
        Rs, it = lll(B)
        print('trial', trial, 'iters', it)
        print('sympy:', Matrix(B).lll())
        print('ours :', Matrix(Rs))
